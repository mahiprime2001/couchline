/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from 'react';
import { LIMITS, formatTime } from '@wp/shared';
import { onSignal, send, useRoom } from '../lib/room';
import { iceServers, RtcHost } from '../lib/screenRtc';
import { HostStreamer, pickCodecs, type ViewerStat } from '../lib/hostStreamer';
import { loadHandle, pickVideoFile, reopenHandle, saveHandle } from '../lib/fileHandle';
import { useHostedFallback } from '../lib/hostedFallback';

/** The most the screen share sends. Each viewer's connection adapts below it to what the host's upload can carry. */
const STREAM_BITRATE = 2_500_000;

const NO_AUDIO =
  'No sound is being streamed: this file has no audio, or your browser cannot play its audio format (common with AC3, E-AC3 or DTS in movie .mkv/.mp4 files). Viewers get the video only. To keep the sound, convert just the audio: ffmpeg -i input.mkv -c:v copy -c:a aac output.mp4  (or play the file in another player and use "Share a screen / tab" with system audio).';

const CANNOT_PLAY =
  'Your browser cannot play this file\'s picture or sound. "Convert on the server" works for any format and plays on every device.';

type VideoWithCounts = HTMLVideoElement & { webkitVideoDecodedByteCount?: number; webkitAudioDecodedByteCount?: number };

const NO_AUDIO_SCREEN =
  'No sound is being shared. In the browser\'s share window choose "Entire screen" and tick "Share system audio", or choose a "Chrome tab" and tick "Share tab audio". Sharing a single window never includes sound. Stop streaming and share again to fix it.';

interface StartInfo {
  fileName: string;
  fileSize: number;
  source: 'file' | 'screen';
  position: number;
}

const isChromium = (): boolean => {
  const brands = (navigator as any).userAgentData?.brands as Array<{ brand: string }> | undefined;
  return !!brands?.some((b) => /Chrom/i.test(b.brand));
};

/** `pickSignal` goes up each time the host presses "Choose a video from this device" in the room bar. */
export function StreamHost({ pickSignal = 0, screenSignal = 0 }: { pickSignal?: number; screenSignal?: number }) {
  const code = useRoom((s) => s.code);
  const sync = useRoom((s) => s.sync);
  const stream = useRoom((s) => s.stream);
  const members = useRoom((s) => s.members);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamerRef = useRef<HostStreamer | null>(null);
  // the direct (WebRTC) connections to the viewers; the server path above is only for viewers who cannot connect
  const rtcRef = useRef<RtcHost | null>(null);
  const [directViewers, setDirectViewers] = useState(0);
  const mediaRef = useRef<MediaStream | null>(null);
  const urlRef = useRef('');
  // the file being played, so a sound problem found later can still offer converting it
  const fileRef = useRef<File | null>(null);
  const fallback = useHostedFallback((s) => s.file);
  const posTimer = useRef<number | undefined>(undefined);

  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stats, setStats] = useState<ViewerStat[]>([]);
  // the server path adjusts this itself when a viewer falls behind (see HostStreamer); there is no manual choice
  const [bitrate, setBitrate] = useState(STREAM_BITRATE);
  const [source, setSource] = useState<'file' | 'screen'>('file');

  // getDisplayMedia is missing on phone browsers, and on plain-http pages (not a secure context)
  const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const codecs = pickCodecs();
  // the stream goes through the room server, so only recording WebM matters here
  const supported = codecs !== null;
  const resumable = sync.mode === 'stream' && !stream.live && !live;

  useEffect(
    () =>
      onSignal((from, data) => {
        if (typeof data?.kind === 'string' && data.kind.startsWith('stream-')) {
          streamerRef.current?.handleSignal(from, data);
        } else if (typeof data?.kind === 'string' && data.kind.startsWith('rtc-')) {
          rtcRef.current?.handleSignal(from, data);
        }
      }),
    [],
  );

  // someone who leaves the room stops being sent the stream
  useEffect(() => {
    streamerRef.current?.keepOnly(members.map((m) => m.id));
    rtcRef.current?.keepOnly(members.map((m) => m.id));
  }, [members]);

  const cleanup = () => {
    window.clearInterval(posTimer.current);
    streamerRef.current?.stop();
    streamerRef.current = null;
    rtcRef.current?.stop();
    rtcRef.current = null;
    setDirectViewers(0);
    mediaRef.current?.getTracks().forEach((t) => t.stop());
    mediaRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = '';
    const v = videoRef.current;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.srcObject = null;
    }
    setStats([]);
  };

  // leaving the page (or the room switching to a link) ends the stream
  useEffect(() => cleanup, []);

  // Tell viewers when the host pauses or resumes, so they rest on the last frame instead of
  // sitting on a frozen picture that looks like it is still trying to play.
  useEffect(() => {
    const v = videoRef.current;
    if (!live || source !== 'file' || !v) return;
    const onPause = () => {
      send({ t: 'control', action: 'pause', position: v.currentTime });
      streamerRef.current?.setPaused(true);
    };
    const onPlay = () => {
      streamerRef.current?.setPaused(false);
      send({ t: 'control', action: 'play', position: v.currentTime });
    };
    v.addEventListener('pause', onPause);
    v.addEventListener('play', onPlay);
    return () => {
      v.removeEventListener('pause', onPause);
      v.removeEventListener('play', onPlay);
    };
  }, [live, source]);

  const begin = async (ms: MediaStream, info: StartInfo) => {
    // declare only the tracks that really exist (see pickCodecs)
    const hasAudio = ms.getAudioTracks().length > 0;
    const streamCodecs = pickCodecs(hasAudio);
    if (!streamCodecs) throw new Error('This browser cannot encode WebM streams.');
    mediaRef.current = ms;
    const streamer = new HostStreamer({
      stream: ms,
      codecs: streamCodecs,
      bitrate,
      maxViewers: LIMITS.maxViewersStream,
      signal: (to, data) => send({ t: 'signal', to, data }),
      onStats: setStats,
      onBitrate: setBitrate,
    });
    streamerRef.current = streamer;
    streamer.start();
    // the picture goes straight to each viewer over WebRTC; the ICE servers arrive a moment later (see RtcHost)
    const rtc = new RtcHost({ signal: (to, data) => send({ t: 'signal', to, data }), onCount: setDirectViewers, assign: true });
    rtcRef.current = rtc;
    rtc.setStream(ms, bitrate);
    void iceServers().then((ice) => rtc.setIceServers(ice));
    send({ t: 'streamStart', ...info });
    setLive(true);
    setNotice(!hasAudio ? (info.source === 'file' ? NO_AUDIO : NO_AUDIO_SCREEN) : null);
    if (!hasAudio && info.source === 'file' && fileRef.current) useHostedFallback.getState().offer(fileRef.current, NO_AUDIO);
    if (info.source === 'file' && hasAudio) {
      // a track can exist while the browser decodes nothing from it: check that sound is really playing
      window.setTimeout(() => {
        const v = videoRef.current as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number }) | null;
        if (v && !v.paused && v.webkitAudioDecodedByteCount === 0) {
          setNotice(NO_AUDIO);
          if (fileRef.current) useHostedFallback.getState().offer(fileRef.current, NO_AUDIO);
        }
      }, 3500);
    }
    if (info.source === 'file') {
      posTimer.current = window.setInterval(() => {
        const v = videoRef.current;
        if (v) send({ t: 'streamPosition', position: v.currentTime });
      }, 5000);
    }
  };

  const startFile = async (file: File, startAt: number) => {
    const v = videoRef.current!;
    setSource('file');
    useHostedFallback.getState().clear();
    fileRef.current = file;
    urlRef.current = URL.createObjectURL(file);
    v.srcObject = null;
    v.src = urlRef.current;
    await new Promise<void>((res, rej) => {
      v.onloadedmetadata = () => res();
      v.onerror = () => {
        useHostedFallback.getState().offer(file, CANNOT_PLAY);
        rej(new Error(CANNOT_PLAY));
      };
    });
    if (startAt > 0 && startAt < v.duration - 1) v.currentTime = startAt;
    await v.play();
    // a picture the browser cannot decode still "plays" with no frames (Chrome counts the decoded bytes)
    await new Promise((r) => window.setTimeout(r, 3000));
    if ((v as VideoWithCounts).webkitVideoDecodedByteCount === 0) {
      useHostedFallback.getState().offer(file, CANNOT_PLAY);
      throw new Error(CANNOT_PLAY);
    }
    const ms: MediaStream | undefined = (v as any).captureStream?.() ?? (v as any).mozCaptureStream?.();
    if (!ms) throw new Error('This browser cannot capture video from a file. Use Chrome, Edge or Brave.');
    await begin(ms, { fileName: file.name, fileSize: file.size, source: 'file', position: startAt });
  };

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      cleanup();
      setLive(false);
      setError((e as Error).message || 'Could not start the stream.');
    } finally {
      setBusy(false);
    }
  };

  const chooseFile = () =>
    guard(async () => {
      const r = await pickVideoFile();
      if (!r) return;
      if (r.handle) void saveHandle(code, r.handle);
      await startFile(r.file, 0);
    });

  useEffect(() => {
    // opens the chooser right away; the click that bumped pickSignal is still a fresh user gesture
    if (pickSignal > 0 && !live && !busy && supported) void chooseFile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickSignal]);

  useEffect(() => {
    // the "Share screen / tab" button in the room bar: the click is still a fresh user gesture
    if (screenSignal > 0 && !live && !busy && supported && canScreenShare) void shareScreen();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenSignal]);

  const resume = () =>
    guard(async () => {
      let file: File | null = null;
      const h = await loadHandle(code);
      if (h) file = await reopenHandle(h);
      if (!file) {
        const r = await pickVideoFile();
        if (!r) return;
        file = r.file;
        if (r.handle) void saveHandle(code, r.handle);
      }
      if ((file.name !== stream.fileName || file.size !== stream.fileSize) && !confirm(`This is not the original file ("${stream.fileName}"). Continue anyway?`)) return;
      await startFile(file, stream.lastPosition);
    });

  const shareScreen = () =>
    guard(async () => {
      // `systemAudio: 'include'` asks Chrome to offer the "Share system audio" checkbox
      const ms = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 30 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
      const v = videoRef.current!;
      setSource('screen');
      v.src = '';
      v.srcObject = ms;
      v.muted = true; // avoid echo in the host's own tab
      await v.play();
      ms.getVideoTracks()[0]?.addEventListener('ended', () => stop());
      await begin(ms, { fileName: 'Screen share', fileSize: 0, source: 'screen', position: 0 });
    });

  const stop = () => {
    send({ t: 'streamStop' });
    cleanup();
    setLive(false);
  };

  // the file this browser could not stream goes to the server instead (HostedUpload converts and hosts it)
  const convertButton = (
    <button
      className="chipbtn"
      onClick={() => {
        setError(null);
        setNotice(null);
        if (live) stop();
        useHostedFallback.getState().requestConvert();
      }}
    >
      Convert on the server and host it
    </button>
  );


  const nameOf = (id: string) => members.find((m) => m.id === id)?.nick ?? 'viewer';

  return (
    <div className="stage-inner host-panel">
      <div className="video-area" style={{ display: live ? undefined : 'none' }}>
        <video ref={videoRef} controls={source === 'file'} playsInline />
      </div>

      {live ? (
        <div className="host-live">
          <div className="host-bar">
            <span className="live-badge">● STREAMING</span>
            <span className="muted">{stats.length + directViewers} watching (max {LIMITS.maxViewersStream})</span>
            <span className="spacer" />
            <button className="danger" onClick={stop}>
              Stop streaming
            </button>
          </div>
          {stats.length > 0 && (
            <ul className="stats">
              {stats.map((s) => (
                <li key={s.id}>
                  <span>{nameOf(s.id)}</span>
                  <span className={s.lag > 6 ? 'bad' : 'good'}>{s.lag > 0.5 ? `${formatTime(s.lag)} behind` : 'live'}</span>
                  <span className="muted">{(s.backlog / 1000).toFixed(0)} KB queued</span>
                </li>
              ))}
            </ul>
          )}
          {notice && <p className="warn small">{notice}</p>}
          {notice && fallback && convertButton}
          <p className="muted small">Pausing or seeking in your player is what everyone sees. Viewers can rewind, never skip ahead.</p>
        </div>
      ) : (
        <div className="host-start">
          <h2>{resumable ? 'Host reconnected' : 'Stream from your computer'}</h2>
          <p className="muted">
            The video streams live from this tab to everyone in the room. Nothing is stored on the server, so keep this tab open.
          </p>
          {!supported && <p className="warn">This browser cannot stream video. Use a recent Chrome, Edge or Brave on desktop.</p>}
          {supported && !isChromium() && <p className="warn">Streaming is tested on Chromium browsers (Chrome, Edge, Brave). Other browsers may not work.</p>}
          {resumable && (
            <div className="resume">
              <p>
                Resume <b>{stream.fileName || 'your stream'}</b>
                {stream.source === 'file' && <> from {formatTime(stream.lastPosition)}</>}
              </p>
              {stream.source === 'file' ? (
                <button className="primary" disabled={busy || !supported} onClick={resume}>
                  Resume stream
                </button>
              ) : (
                <button className="primary" disabled={busy || !supported} onClick={shareScreen}>
                  Share screen again
                </button>
              )}
            </div>
          )}
          <div className="row">
            <button className="primary" disabled={busy || !supported} onClick={chooseFile}>
              {resumable ? 'Choose a different file' : 'Choose a video file'}
            </button>
            {canScreenShare && (
              <button disabled={busy || !supported} onClick={shareScreen}>
                Share a screen / tab
              </button>
            )}
          </div>
          {!canScreenShare && (
            <p className="muted small">Screen sharing is not available in this browser (phones and tablets do not support it, and it needs a secure https page).</p>
          )}
          {error && <p className="warn">{error}</p>}
          {error && fallback && convertButton}
        </div>
      )}
    </div>
  );
}
