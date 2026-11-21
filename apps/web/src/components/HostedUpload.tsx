import { useEffect, useRef, useState } from 'react';
import { computePosition, isTorrentLink } from '@wp/shared';
import { send, serverNow, useRoom } from '../lib/room';
import { useToast } from '../lib/toast';
import { useHostedFallback } from '../lib/hostedFallback';
import { useLinkStatus } from '../lib/linkStatus';

type Job =
  | { phase: 'uploading'; name: string; pct: number }
  | { phase: 'downloading'; name: string; pct: number; detail?: string }
  | { phase: 'converting'; name: string; pct: number; detail?: string }
  | { phase: 'playing'; name: string; pct: number; done: boolean }
  | { phase: 'error'; name: string; message: string };

const fmtRate = (bytesPerSec: number): string =>
  bytesPerSec >= 1024 * 1024 ? `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1024)} KB/s`;

/** "4 peers · 812 KB/s", or "looking for peers…" before the first one answers; the conversion speed while converting */
const detailOf = (st: { state: string; progress: number; peers?: number; rate?: number; speed?: string | null }): string => {
  const parts: string[] = [];
  if (st.peers !== undefined) parts.push(st.peers === 0 && st.progress === 0 ? 'looking for peers…' : `${st.peers} peer${st.peers === 1 ? '' : 's'}`);
  if (st.rate) parts.push(fmtRate(st.rate));
  if (st.state === 'converting' && st.speed) parts.push(`converting at ${st.speed}x`);
  return parts.join(' · ');
};

interface Props {
  /** the link in the room's link box, for "Download & host" (yt-dlp) */
  link: string;
  /** the link was handed to the server, so the link box can be cleared */
  onLinkUsed(): void;
}

/**
 * "YouTube-style" hosting: the host uploads any audio/video file (or, on the server's own computer, has
 * yt-dlp download a link), the server converts it into short chunks (HLS), and everyone plays those chunks.
 * Playback starts as soon as the first chunks exist, while the rest is still converting.
 */
export function HostedUpload({ link, onLinkUsed }: Props) {
  const code = useRoom((s) => s.code);
  const sync = useRoom((s) => s.sync);
  const [media, setMedia] = useState<{ available: boolean; maxMB: number; ytdlp?: boolean } | null>(null);
  // auto: any YouTube link that starts playing in the room (approved suggestion, queue, pasted link) is
  // fetched with yt-dlp and the room switches to that hosted copy (quality + audio menus, no ads)
  const [auto, setAuto] = useState(() => localStorage.getItem('wp-ytdlp-auto') !== '0');
  const autoUrl = useRef('');
  // music mode: fetch only the sound (a few MB, ready in seconds); everyone sees the cover instead of a picture
  const [music, setMusic] = useState(() => localStorage.getItem('wp-music') === '1');
  const musicRef = useRef(music);
  musicRef.current = music;
  // links already fetched ahead of time (the next song in Up next), so they start without a wait
  const preloaded = useRef(new Set<string>());
  const nextUp = useRoom((s) => s.queue.find((q) => q.approved && (q.kind === 'youtube' || q.kind === 'site'))?.url ?? null);
  const [job, setJob] = useState<Job | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const pollRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json() as Promise<{ media?: { available: boolean; maxMB: number; ytdlp?: boolean } }>)
      .then((j) => setMedia(j.media ?? { available: false, maxMB: 0 }))
      .catch(() => setMedia({ available: false, maxMB: 0 }));
    return () => {
      xhrRef.current?.abort();
      window.clearInterval(pollRef.current);
    };
  }, []);

  const fail = (name: string, message: string) => {
    window.clearInterval(pollRef.current);
    setJob({ phase: 'error', name, message });
    useToast.getState().show(`${name}: ${message}`);
  };

  /** `roomUrl`: only take over the room if it is still on this link (nobody switched videos meanwhile) */
  const watchConversion = (id: string, name: string, roomUrl: string | null = null) => {
    let loaded = false;
    const tick = async () => {
      if (roomUrl && !loaded && useRoom.getState().sync.url !== roomUrl) {
        window.clearInterval(pollRef.current);
        setJob(null);
        return;
      }
      try {
        const r = await fetch(`/api/media/${id}`);
        if (!r.ok) return fail(name, 'The server lost this video (it may have expired). Try again.');
        const st = (await r.json()) as {
          state: string;
          progress: number;
          playable: boolean;
          entry?: string;
          name?: string;
          duration?: number;
          error: string | null;
          peers?: number;
          rate?: number;
          speed?: string | null;
        };
        const shown = st.name || name; // yt-dlp reports the real title once it knows it
        if (st.state === 'error') {
          // a YouTube link the room is already playing simply carries on as a normal YouTube video
          const now = useRoom.getState().sync;
          const fallback = roomUrl && !loaded && now.url === roomUrl;
          if (fallback && now.kind === 'site') send({ t: 'queueNext' }); // a site link cannot play any other way
          return fail(shown, `${st.error ?? 'Conversion failed.'}${fallback ? (now.kind === 'site' ? ' Skipping it.' : ' The normal YouTube version keeps playing.') : ''}`);
        }
        if (st.state === 'downloading') return setJob({ phase: 'downloading', name: shown, pct: st.progress, detail: detailOf(st) });
        // Taking over a YouTube video that is already playing: wait until the copy is converted a bit past the
        // room's current moment, then switch to it right there (no restart from 0:00).
        const room = useRoom.getState().sync;
        if (roomUrl && !loaded && room.url !== roomUrl) {
          // the room moved on while this answer was on its way: drop it
          window.clearInterval(pollRef.current);
          setJob(null);
          return;
        }
        // a YouTube video was already playing: hand over at the same moment. A site link never played: start at 0.
        const handoff = !!roomUrl && room.kind === 'youtube';
        const at = handoff ? computePosition(room, serverNow()) : 0;
        const farEnough = st.state === 'done' || st.progress * (st.duration ?? 0) >= at + 8;
        if (st.playable && !loaded && (!roomUrl || farEnough)) {
          loaded = true;
          // the server says which playlist to open: index.m3u8 (simple) or master.m3u8 (several qualities / audio tracks)
          // a copy of a YouTube video remembers which one (?yt=), so the Queue tab can still suggest what comes next
          const ytId = roomUrl && handoff ? new URL(roomUrl).searchParams.get('v') : null;
          // the copy names its source (?yt= for YouTube, ?src= for any other page) so the room treats it as the same item
          const tag = ytId ? `?yt=${ytId}` : roomUrl ? `?src=${encodeURIComponent(roomUrl)}` : '';
          send({ t: 'load', url: `${location.origin}/media/${id}/${st.entry ?? 'index.m3u8'}${tag}`, ...(st.name && !handoff ? { title: st.name } : {}) });
          if (handoff && (at > 1 || !room.playing)) {
            send({ t: 'control', action: room.playing ? 'seek' : 'pause', position: room.playing ? at + 0.3 : at });
          }
        }
        if (loaded) setJob({ phase: 'playing', name: shown, pct: st.progress, done: st.state === 'done' });
        else setJob({ phase: 'converting', name: shown, pct: st.progress, detail: detailOf(st) });
        if (st.state === 'done') window.clearInterval(pollRef.current);
      } catch {
        /* a missed poll is fine, the next one retries */
      }
    };
    window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(tick, 1000);
    void tick();
  };

  const upload = (file: File) => {
    if (media && file.size > media.maxMB * 1024 * 1024) {
      return fail(file.name, `This file is larger than the server's limit (${media.maxMB} MB).`);
    }
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open('PUT', `/api/media?room=${encodeURIComponent(code)}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('x-host-token', localStorage.getItem(`wp-host-${code}`) ?? '');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setJob({ phase: 'uploading', name: file.name, pct: e.loaded / e.total });
    };
    xhr.onload = () => {
      xhrRef.current = null;
      let body: { id?: string; error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as typeof body;
      } catch {
        /* not JSON */
      }
      if (xhr.status === 200 && body.id) {
        setJob({ phase: 'converting', name: file.name, pct: 0 });
        watchConversion(body.id, file.name);
      } else {
        fail(file.name, body.error ?? `Upload failed (${xhr.status}).`);
      }
    };
    xhr.onerror = () => fail(file.name, 'Upload failed: the connection dropped.');
    xhr.onabort = () => setJob(null);
    setJob({ phase: 'uploading', name: file.name, pct: 0 });
    xhr.send(file);
  };

  /** yt-dlp downloads `url` on the server; `fromRoom` = it is the YouTube link already loaded in the room */
  const fetchLink = async (url: string, fromRoom: boolean) => {
    if (!url) return;
    // a magnet link is long and unreadable: the job shows "Torrent" until the server knows the real name
    const label = isTorrentLink(url) ? 'Torrent' : url;
    // if yt-dlp cannot get it, a link already in the room simply plays as a normal YouTube video
    const giveUp = (message: string) => {
      const room = useRoom.getState().sync;
      const site = fromRoom && room.url === url && room.kind === 'site';
      fail(label, site ? `${message} Skipping it.` : fromRoom ? `${message} The normal YouTube version keeps playing.` : message);
      if (site) send({ t: 'queueNext' }); // nothing else can play a site link: move on instead of getting stuck
    };
    setJob({ phase: 'downloading', name: label, pct: 0 });
    try {
      const r = await fetch(`/api/media/fetch?room=${encodeURIComponent(code)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-host-token': localStorage.getItem(`wp-host-${code}`) ?? '' },
        body: JSON.stringify({ url, audio: fromRoom && musicRef.current }),
      });
      const body = (await r.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!r.ok || !body.id) return giveUp(body.error ?? `Download failed (${r.status}).`);
      if (!fromRoom) onLinkUsed();
      watchConversion(body.id, label, fromRoom ? url : null);
    } catch {
      giveUp('Could not reach the server.');
    }
  };

  const busy = job?.phase === 'uploading' || job?.phase === 'downloading' || job?.phase === 'converting';

  useEffect(() => {
    // the copy is playing (or something else is): the same link played again later must be fetched again
    if (sync.kind === 'hls' || sync.kind === 'file') autoUrl.current = '';
    // YouTube: only with the auto switch on. Any other page: always, it cannot play any other way.
    const site = sync.kind === 'site';
    // a torrent needs only ffmpeg on the server (no yt-dlp); anything else from a site needs yt-dlp
    const ready = isTorrentLink(sync.url) ? media?.available : media?.ytdlp;
    if ((!auto && !site) || !ready || busy) return;
    if (sync.mode !== 'link' || (sync.kind !== 'youtube' && !site) || sync.url === autoUrl.current) return;
    autoUrl.current = sync.url;
    if (site) send({ t: 'control', action: 'pause', position: 0 }); // the room waits at 0:00 until the copy is ready
    // the YouTube video keeps playing meanwhile; the copy takes over at the same moment once it is ready
    void fetchLink(sync.url, true);
  }, [auto, media, busy, sync.mode, sync.kind, sync.url]); // eslint-disable-line react-hooks/exhaustive-deps

  // music mode, no gap between songs: while a song plays, quietly fetch the next YouTube song in Up next.
  // The server keeps that copy, so when the queue moves on it is handed straight back.
  useEffect(() => {
    if (!auto || !music || !media?.ytdlp || !nextUp || sync.kind !== 'hls' || preloaded.current.has(nextUp)) return;
    preloaded.current.add(nextUp);
    fetch(`/api/media/fetch?room=${encodeURIComponent(code)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-token': localStorage.getItem(`wp-host-${code}`) ?? '' },
      body: JSON.stringify({ url: nextUp, audio: true }),
    }).catch(() => preloaded.current.delete(nextUp));
  }, [auto, music, media, nextUp, sync.kind, code]);
  // the player shows what is happening while a link loads (the viewers see it on the picture, not only here)
  useEffect(() => {
    const text =
      !job || job.phase === 'playing' || job.phase === 'uploading'
        ? null
        : job.phase === 'error'
          ? job.message
          : job.phase === 'downloading'
            ? `Loading from the internet: ${Math.round(job.pct * 100)}%${job.detail ? ` · ${job.detail}` : ''}`
            : `Preparing the video for everyone: ${Math.round(job.pct * 100)}%${job.detail ? ` · ${job.detail}` : ''}`;
    useLinkStatus.setState({ text });
  }, [job]);
  useEffect(() => () => useLinkStatus.setState({ text: null }), []);
  const unavailable = media !== null && !media.available;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  // "Convert on the server" from the stream panel: this file could not be streamed, so it is hosted instead.
  // The counter is remembered, so mounting again does not start the same conversion twice.
  const convertNonce = useHostedFallback((s) => s.convert);
  const handledConvert = useRef(0);
  useEffect(() => {
    if (convertNonce <= handledConvert.current) return;
    handledConvert.current = convertNonce;
    const file = useHostedFallback.getState().file;
    useHostedFallback.getState().clear();
    if (file) upload(file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convertNonce]);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        hidden
        accept="video/*,audio/*,.mkv,.avi,.flv,.wmv,.ts,.m2ts,.mov,.webm,.mp4,.m4v,.mp3,.flac,.ogg,.opus,.wav,.aac,.m4a"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) upload(f);
        }}
      />
      {media && (media.ytdlp || isTorrentLink(link)) && (
        <button
          type="button"
          className="chipbtn"
          disabled={busy || !link.trim()}
          title={
            link.trim()
              ? isTorrentLink(link)
                ? 'Download this torrent on the server (the biggest video or audio file in it), then host it for everyone'
                : 'Download this link with yt-dlp on your computer, then host it for everyone: quality and audio menus, no ads, and it works where embedding is blocked'
              : 'Paste a link in the box first (YouTube, most video sites and torrents work)'
          }
          onClick={() => void fetchLink(link.trim(), false)}
        >
          ⬇️ Download &amp; host link
        </button>
      )}
      {media?.ytdlp && (
        <label className="check small" title="When a YouTube link starts playing (an approved suggestion, the queue, or a pasted link), fetch it with yt-dlp and play that copy instead: quality and audio menus, no ads">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              localStorage.setItem('wp-ytdlp-auto', e.target.checked ? '1' : '0');
            }}
          />
          Auto yt-dlp for YouTube
        </label>
      )}
      {media?.ytdlp && (
        <label className="check small" title="Fetch only the sound of YouTube links: songs are ready in seconds, everyone sees the cover art, and the next song in Up next is fetched ahead so there is no gap">
          <input
            type="checkbox"
            checked={music}
            disabled={!auto}
            onChange={(e) => {
              setMusic(e.target.checked);
              localStorage.setItem('wp-music', e.target.checked ? '1' : '0');
            }}
          />
          🎵 Music mode
        </label>
      )}
      <button
        type="button"
        className="chipbtn"
        disabled={busy || media === null || unavailable}
        title={
          unavailable
            ? 'Not available on this server: hosting needs ffmpeg installed on the server.'
            : 'Upload any video or audio file. The server converts it so every device can play it, with sound.'
        }
        onClick={() => inputRef.current?.click()}
      >
        ☁️ Upload a file
      </button>
      {busy && job?.phase === 'uploading' && (
        <button type="button" className="chipbtn" onClick={() => xhrRef.current?.abort()} title="Cancel the upload">
          Cancel
        </button>
      )}
      {unavailable && <span className="muted small source-note">Uploading and hosting needs ffmpeg on the server. Streaming from your computer still works.</span>}
      {job && (
        <span className="hosted-status small source-note" role="status">
          {job.phase === 'uploading' && (
            <>
              ⬆️ Uploading <b>{job.name}</b> {pct(job.pct)} <progress value={job.pct} max={1} />
            </>
          )}
          {job.phase === 'downloading' && (
            <>
              ⬇️ Downloading <b>{job.name}</b> {pct(job.pct)} <progress value={job.pct} max={1} />{' '}
              {job.detail && <span className="muted">{job.detail}</span>}
            </>
          )}
          {job.phase === 'converting' && (
            <>
              ⚙️ Converting <b>{job.name}</b> {pct(job.pct)} <progress value={job.pct} max={1} />{' '}
              {job.detail && <span className="muted">{job.detail}</span>}
            </>
          )}
          {job.phase === 'playing' && (
            <>
              ▶️ Playing <b>{job.name}</b> for everyone.{' '}
              {job.done ? 'Fully converted.' : <>Still converting in the background ({pct(job.pct)}); you can only seek as far as what is ready.</>}
            </>
          )}
          {job.phase === 'error' && (
            <span className="warn">
              ⚠️ <b>{job.name}</b>: {job.message}
            </span>
          )}
        </span>
      )}
    </>
  );
}
