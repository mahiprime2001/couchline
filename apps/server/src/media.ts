// "YouTube-style" hosting: the host uploads any video/audio file, ffmpeg cuts it into short HLS
// chunks and viewers play the chunks with a normal HLS player. When the file warrants it, the output
// is a multi-variant HLS stream: several video qualities (1080p/720p/480p/360p), every audio track
// of the source as a selectable rendition, and text subtitles as .vtt files listed in tracks.json.
// Files live in a temp folder and are deleted when the room closes or after MEDIA_TTL_HOURS.
// Needs ffmpeg + ffprobe on the server.
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import WebTorrent, { type Torrent, type TorrentFile } from 'webtorrent';
import { isTorrentLink } from '@wp/shared';

export type MediaState = 'uploading' | 'downloading' | 'queued' | 'converting' | 'done' | 'error';

interface Item {
  id: string;
  room: string;
  name: string;
  state: MediaState;
  error: string | null;
  bytes: number;
  duration: number;
  progress: number;
  createdAt: number;
  proc: ChildProcess | null;
  /** playlist the player should open once `playable` */
  entry: string;
  /** how many stream_*.m3u8 variant playlists the multi-variant output will have (0 = simple output) */
  expectedVariants: number;
  /**
   * In-memory copies of the playlists ffmpeg is writing. We serve these instead of the files: on Windows
   * ffmpeg updates a playlist by renaming a temp file over it, and that fails ("Operation not permitted")
   * whenever something has the playlist open, which used to leave playlists stuck a few seconds in.
   */
  lists: Map<string, Buffer>;
  timer: NodeJS.Timeout | null;
  /** the link yt-dlp downloaded this from (null for uploads), and whether only the sound was fetched */
  source: string | null;
  audio: boolean;
  /** stops a torrent download that is still running (yt-dlp uses `proc` instead) */
  cancel: (() => void) | null;
  /** torrent: peers connected now, and download speed in bytes per second */
  peers: number;
  rate: number;
  /** ffmpeg's conversion speed, as a multiple of real time ("1.2" = 1.2x), while converting */
  ffSpeed: string | null;
}

/** the video and audio files a torrent may hold: only one of them is downloaded */
const MEDIA_FILE = /\.(mp4|mkv|webm|mov|m4v|avi|flv|wmv|ts|m2ts|mp3|m4a|aac|flac|ogg|opus|wav)$/i;

export interface MediaOptions {
  dir: string;
  ffmpeg: string;
  ffprobe: string;
  maxBytes: number;
  maxTotalBytes: number;
  ttlMs: number;
  /** how many hosted videos a room keeps; uploading another removes the oldest */
  perRoom: number;
  /** 'auto': extra lower qualities for big sources. 'original': one quality only (cheapest for the server) */
  qualities: 'auto' | 'original';
  /** yt-dlp binary, for hosting a video from a link (YouTube and most video sites) instead of a file */
  ytdlp: string;
  isHost(room: string, token: string | undefined): boolean;
}

interface TrackInfo {
  lang: string | null;
  title: string | null;
}

interface SubInfo extends TrackInfo {
  /** image-based subtitles (PGS, DVD) cannot become WebVTT */
  text: boolean;
}

interface Probe {
  duration: number;
  videoIndex: number;
  srcHeight: number;
  audio: TrackInfo[];
  subs: SubInfo[];
  videoCopyOk: boolean;
}

const BITRATE_K: Record<number, number> = { 1080: 5000, 720: 2800, 480: 1400, 360: 800 };
const TEXT_SUBS = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];
const LANGS: Record<string, string> = {
  eng: 'English', hin: 'Hindi', spa: 'Spanish', fra: 'French', fre: 'French', deu: 'German', ger: 'German', por: 'Portuguese',
  ita: 'Italian', jpn: 'Japanese', kor: 'Korean', zho: 'Chinese', chi: 'Chinese', rus: 'Russian', ara: 'Arabic', tam: 'Tamil',
  tel: 'Telugu', kan: 'Kannada', mal: 'Malayalam', ben: 'Bengali', mar: 'Marathi', tur: 'Turkish', pol: 'Polish', nld: 'Dutch',
  dut: 'Dutch', swe: 'Swedish', tha: 'Thai', vie: 'Vietnamese', ind: 'Indonesian', urd: 'Urdu', pan: 'Punjabi', guj: 'Gujarati',
};

const trackName = (t: TrackInfo, n: number): string =>
  t.title?.trim() || (t.lang && LANGS[t.lang.toLowerCase()]) || (t.lang && t.lang.toUpperCase()) || `Track ${n + 1}`;

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/**
 * Refuse an upload early. We answer straight away, then read and throw away the body so the client can
 * finish sending and actually see our message (closing the socket mid-upload shows up in browsers as a
 * bare network error). The discard is capped so nobody can burn our bandwidth with a huge refused upload.
 */
function reject(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  send(res, status, body);
  let discarded = 0;
  req.on('data', (c: Buffer) => {
    discarded += c.length;
    if (discarded > 1_000_000) req.destroy();
  });
  req.resume();
}

export function createMedia(opts: MediaOptions) {
  const items = new Map<string, Item>();
  const queue: string[] = [];
  let running = false;

  // nothing survives a restart, by design. Empty the folder rather than delete it: it can be a mounted volume (in
  // Docker, for one), which cannot be removed.
  mkdirSync(opts.dir, { recursive: true });
  for (const name of readdirSync(opts.dir)) rmSync(join(opts.dir, name), { recursive: true, force: true });
  const probeBin = spawnSync(opts.ffmpeg, ['-version'], { timeout: 10_000 });
  const available = !probeBin.error && probeBin.status === 0;
  // yt-dlp (Python) can take several seconds to answer, more while the computer is busy starting things. A
  // failed check is tried again (at most once a minute) instead of turning yt-dlp off until a restart.
  const probeYtdlp = () => {
    const r = spawnSync(opts.ytdlp, ['--version'], { timeout: 30_000, windowsHide: true });
    return available && !r.error && r.status === 0;
  };
  let ytdlpFound = probeYtdlp();
  let ytdlpCheckedAt = Date.now();
  const ytdlpAvailable = (): boolean => {
    if (!ytdlpFound && Date.now() - ytdlpCheckedAt > 60_000) {
      ytdlpCheckedAt = Date.now();
      ytdlpFound = probeYtdlp();
    }
    return ytdlpFound;
  };

  const dirOf = (id: string) => join(opts.dir, id);
  const totalBytes = () => [...items.values()].reduce((n, i) => n + i.bytes, 0);

  function remove(id: string): void {
    const item = items.get(id);
    if (!item) return;
    try {
      item.proc?.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    if (item.timer) clearInterval(item.timer);
    item.cancel?.();
    items.delete(id);
    rmSync(dirOf(id), { recursive: true, force: true });
  }

  function probe(src: string): Promise<Probe> {
    return new Promise((resolve, reject) => {
      execFile(
        opts.ffprobe,
        ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,pix_fmt,profile,height:stream_tags=language,title:format=duration', '-of', 'json', src],
        { timeout: 60_000, maxBuffer: 10_000_000 },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            interface Raw {
              codec_type?: string;
              codec_name?: string;
              pix_fmt?: string;
              profile?: string;
              height?: number;
              tags?: { language?: string; title?: string };
            }
            const j = JSON.parse(stdout) as { streams?: Raw[]; format?: { duration?: string } };
            const streams = j.streams ?? [];
            let vIdx = -1;
            let n = 0;
            let video: Raw | undefined;
            const audio: TrackInfo[] = [];
            const subs: SubInfo[] = [];
            for (const s of streams) {
              const info: TrackInfo = {
                lang: s.tags?.language && s.tags.language !== 'und' ? s.tags.language : null,
                title: s.tags?.title ?? null,
              };
              if (s.codec_type === 'video') {
                if (!video && !['mjpeg', 'png', 'bmp', 'gif'].includes(s.codec_name ?? '')) {
                  video = s;
                  vIdx = n; // index among video streams, for -map 0:v:<n>
                }
                n += 1;
              } else if (s.codec_type === 'audio') {
                audio.push(info);
              } else if (s.codec_type === 'subtitle') {
                subs.push({ ...info, text: TEXT_SUBS.includes(s.codec_name ?? '') }); // index = position among ALL subtitle streams
              }
            }
            if (!video && audio.length === 0) return reject(new Error('no audio or video found'));
            resolve({
              duration: Number(j.format?.duration) || 0,
              videoIndex: vIdx,
              srcHeight: video?.height ?? 0,
              audio: audio.slice(0, 8),
              subs,
              // H.264 8-bit 4:2:0 can be chunked without re-encoding (fast); anything else is converted
              videoCopyOk: !!video && video.codec_name === 'h264' && /^yuvj?420p$/.test(video.pix_fmt ?? '') && !/High 10|High 4:/.test(video.profile ?? ''),
            });
          } catch (e) {
            reject(e);
          }
        },
      );
    });
  }

  /** Copy every playlist ffmpeg has written into memory. A failed read (file being replaced right now) keeps the previous copy. */
  function refreshLists(item: Item): void {
    let files: string[] = [];
    try {
      files = readdirSync(dirOf(item.id)).filter((f) => f.endsWith('.m3u8'));
    } catch {
      return;
    }
    for (const f of files) {
      try {
        item.lists.set(f, readFileSync(join(dirOf(item.id), f)));
      } catch {
        /* keep the last good copy */
      }
    }
  }

  /**
   * After ffmpeg exits, make sure every playlist lists all of its chunks and ends properly. If an update
   * was lost (see `lists`), rebuild the missing tail from the chunk files that are on disk.
   */
  function repairPlaylists(item: Item): void {
    let present: string[] = [];
    try {
      present = readdirSync(dirOf(item.id));
    } catch {
      return;
    }
    for (const [name, buf] of item.lists) {
      if (!/^(stream_.+|index)\.m3u8$/.test(name)) continue;
      let text = buf.toString();
      const listed = new Set(text.match(/^seg_[\w-]+\.ts$/gm) ?? []);
      const first = [...listed][0];
      if (!first) continue;
      const prefix = first.replace(/\d{5}\.ts$/, '');
      const onDisk = present.filter((f) => f.startsWith(prefix) && /^\d{5}\.ts$/.test(f.slice(prefix.length))).sort();
      const missing = onDisk.filter((f) => !listed.has(f));
      if (missing.length === 0 && text.includes('#EXT-X-ENDLIST')) continue;
      if (!text.endsWith('\n')) text += '\n';
      for (const f of missing) text += `#EXTINF:4.000000,\n${f}\n`;
      if (!text.includes('#EXT-X-ENDLIST')) text += '#EXT-X-ENDLIST\n';
      item.lists.set(name, Buffer.from(text));
      try {
        writeFileSync(join(dirOf(item.id), name), text); // ffmpeg is finished, so nothing is racing us now
      } catch {
        /* the in-memory copy is what gets served */
      }
      console.warn(`[media ${item.id.slice(0, 8)}] repaired ${name}: added ${missing.length} chunk(s)`);
    }
  }

  /** Pull each text subtitle stream out as a standalone .vtt file. Failures are skipped, never fatal. */
  async function extractSubtitles(src: string, dir: string, subs: SubInfo[]): Promise<Array<{ url: string; name: string; lang: string | null }>> {
    const out: Array<{ url: string; name: string; lang: string | null }> = [];
    for (let j = 0; j < subs.length && out.length < 8; j++) {
      const s = subs[j]!;
      if (!s.text) continue;
      const file = `sub_${out.length}.vtt`;
      const ok = await new Promise<boolean>((resolve) => {
        execFile(opts.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', src, '-map', `0:s:${j}`, '-c:s', 'webvtt', join(dir, file)], { timeout: 120_000 }, (err) => resolve(!err));
      });
      if (ok && existsSync(join(dir, file)) && statSync(join(dir, file)).size > 10) out.push({ url: file, name: trackName(s, j), lang: s.lang });
    }
    return out;
  }

  /** Runs ffmpeg in `dir` and keeps the item's playlists current until it exits. */
  function runFfmpeg(item: Item, args: string[], dir: string): Promise<void> {
    return new Promise<void>((resolve) => {
      const proc = spawn(opts.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: dir });
      item.proc = proc;
      item.timer = setInterval(() => refreshLists(item), 400);
      let errTail = '';
      proc.stderr.on('data', (d: Buffer) => {
        errTail = (errTail + d.toString()).slice(-600);
      });
      proc.stdout.on('data', (d: Buffer) => {
        const m = d.toString().match(/out_time_us=(\d+)/g);
        const last = m?.[m.length - 1]?.split('=')[1];
        if (last && item.duration > 0) item.progress = Math.min(1, Number(last) / 1e6 / item.duration);
        const speed = [...d.toString().matchAll(/speed=\s*([\d.]+)x/g)].pop();
        if (speed) item.ffSpeed = speed[1]!;
      });
      proc.on('error', () => {
        item.state = 'error';
        item.error = 'ffmpeg could not be started on the server.';
        resolve();
      });
      proc.on('close', (code) => {
        item.proc = null;
        // ffmpeg can finish "successfully" while complaining (for example a playlist it could not rewrite)
        if (errTail.trim()) console.warn(`[media ${item.id.slice(0, 8)}] ffmpeg exit ${code}:`, errTail.trim().slice(-400));
        if (item.timer) clearInterval(item.timer);
        item.timer = null;
        if (!items.has(item.id)) return resolve(); // removed while converting
        if (item.state === 'error') return resolve(); // already failed for another reason (the torrent), keep that message
        refreshLists(item);
        if (code === 0) repairPlaylists(item);
        if (code === 0) {
          item.state = 'done';
          item.progress = 1;
          rmSync(join(dir, 'source'), { force: true }); // the original is no longer needed
        } else {
          item.state = 'error';
          item.error = `Conversion failed. ${errTail.trim().split('\n').slice(-2).join(' ')}`.trim();
        }
        resolve();
      });
    });
  }

  async function convert(item: Item): Promise<void> {
    item.state = 'converting';
    const dir = dirOf(item.id);
    const src = join(dir, 'source');
    let info: Probe;
    try {
      // a file that was just written (a yt-dlp download especially) can be held open for a moment on
      // Windows, e.g. by an antivirus scan, so a failed probe is retried a few times before giving up
      info = await probe(src).catch(async (first: Error) => {
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const again = await probe(src).catch(() => null);
          if (again) return again;
        }
        throw first;
      });
    } catch (e) {
      console.warn(`[media] could not probe ${item.name}: ${(e as Error).message.split('\n').slice(0, 3).join(' ')}`);
      item.state = 'error';
      item.error = 'Could not read this file. Is it a video or audio file?';
      return;
    }
    item.duration = info.duration;
    const hasVideo = info.videoIndex >= 0;

    // quality ladder: the source's own height (max 1080) and the standard lower rungs below it
    const top = Math.min(info.srcHeight || 0, 1080);
    const ladder = hasVideo && opts.qualities === 'auto' && top > 360 ? [top, ...[720, 480, 360].filter((h) => h < top)] : [top || 0];
    const multi = hasVideo ? ladder.length > 1 || info.audio.length > 1 : false;

    const subtitles = await extractSubtitles(src, dir, info.subs);
    const audioNames = info.audio.map((a, i) => trackName(a, i));
    writeFileSync(
      join(dir, 'tracks.json'),
      JSON.stringify({ title: item.name, audio: audioNames.map((name, i) => ({ name, lang: info.audio[i]!.lang })), subtitles, heights: hasVideo ? ladder : [] }),
    );

    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', '-i', src];
    if (!multi) {
      // ---- simple output: one video quality, one audio track, muxed together (the fast common case)
      item.entry = 'index.m3u8';
      item.expectedVariants = 0;
      if (hasVideo) {
        args.push('-map', `0:v:${info.videoIndex}`);
        if (info.videoCopyOk) args.push('-c:v', 'copy');
        else {
          args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p');
          args.push('-vf', "scale='min(1920,iw)':-2", '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0');
        }
      } else {
        args.push('-vn');
      }
      if (info.audio.length > 0) args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
      else args.push('-an');
      args.push('-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments');
      args.push('-hls_segment_filename', join(dir, 'seg_%05d.ts'), join(dir, 'index.m3u8'));
    } else {
      // ---- multi-variant output: several qualities and/or several audio tracks as separate renditions
      item.entry = 'master.m3u8';
      item.expectedVariants = ladder.length + info.audio.length;
      const n = ladder.length;
      if (n > 1) {
        const labels = ladder.map((_, k) => `[s${k}]`).join('');
        const scales = ladder.map((h, k) => `[s${k}]scale=-2:${h},format=yuv420p[v${k}]`).join(';');
        args.push('-filter_complex', `[0:v:${info.videoIndex}]split=${n}${labels};${scales}`);
        ladder.forEach((_, k) => args.push('-map', `[v${k}]`));
        // every quality is re-encoded with aligned keyframes so the player can switch between them cleanly
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0');
        ladder.forEach((h, k) => {
          const br = BITRATE_K[h] ?? 2800;
          args.push(`-b:v:${k}`, `${br}k`, `-maxrate:v:${k}`, `${br}k`, `-bufsize:v:${k}`, `${br * 2}k`);
        });
      } else {
        args.push('-map', `0:v:${info.videoIndex}`);
        if (info.videoCopyOk) args.push('-c:v', 'copy');
        else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*4)', '-sc_threshold', '0');
      }
      info.audio.forEach((_, i) => args.push('-map', `0:a:${i}`));
      if (info.audio.length > 0) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
      const group = info.audio.length > 0 ? ',agroup:aud' : '';
      const used = new Set<string>();
      const entries = ladder.map((_, k) => `v:${k}${group}`);
      info.audio.forEach((a, i) => {
        let slug = audioNames[i]!.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || `audio${i}`;
        if (used.has(slug)) slug = `${slug}_${i}`;
        used.add(slug);
        const lang = a.lang && /^[A-Za-z]{2,3}$/.test(a.lang) ? `,language:${a.lang.toLowerCase()}` : '';
        entries.push(`a:${i},agroup:aud${lang},name:${slug}${i === 0 ? ',default:yes' : ''}`);
      });
      args.push('-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'independent_segments');
      args.push('-master_pl_name', 'master.m3u8', '-hls_segment_filename', 'seg_%v_%05d.ts', '-var_stream_map', entries.join(' '), 'stream_%v.m3u8');
    }

    await runFfmpeg(item, args, dir);
  }

  function pump(): void {
    if (running) return;
    const id = queue.shift();
    if (!id) return;
    const item = items.get(id);
    if (!item) return pump();
    running = true;
    void convert(item).finally(() => {
      running = false;
      pump();
    });
  }

  /** A new hosted video for a room, making room for it by dropping that room's oldest one if needed. */
  function makeItem(room: string, name: string, state: MediaState, bytes: number): Item {
    const mine = [...items.values()].filter((i) => i.room === room).sort((a, b) => a.createdAt - b.createdAt);
    while (mine.length >= opts.perRoom) remove(mine.shift()!.id);
    const id = randomUUID();
    mkdirSync(dirOf(id), { recursive: true });
    const item: Item = {
      id,
      room,
      name,
      state,
      error: null,
      bytes,
      duration: 0,
      progress: 0,
      createdAt: Date.now(),
      proc: null,
      entry: 'index.m3u8',
      expectedVariants: 0,
      lists: new Map(),
      timer: null,
      source: null,
      audio: false,
      cancel: null,
      peers: 0,
      rate: 0,
      ffSpeed: null,
    };
    items.set(id, item);
    return item;
  }

  // one BitTorrent client for every torrent, made on first use (it opens network sockets, so not at start-up)
  let torrents: WebTorrent | null = null;
  const torrentClient = (): WebTorrent => {
    if (!torrents) {
      torrents = new WebTorrent();
      torrents.on('error', (err) => console.warn('[torrent]', err instanceof Error ? err.message : err));
    }
    return torrents;
  };

  /**
   * POST /api/media/fetch?room=CODE   body {"url": "https://..."}   (header x-host-token)
   * Downloads the video with yt-dlp (best quality up to 1080p), then converts it exactly like an upload.
   * A torrent (magnet link or .torrent file) is downloaded with WebTorrent instead (see downloadTorrent).
   * Only a room's host can ask for it (this is meant for a private server: yt-dlp and torrents fetch whatever they are given).
   */
  function fetchUrl(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!available) return reject(req, res, 501, { error: 'ffmpeg must be installed on the server for this.' });
    const room = (url.searchParams.get('room') ?? '').toUpperCase();
    const token = req.headers['x-host-token'];
    if (!/^[A-Z0-9]{4,10}$/.test(room) || !opts.isHost(room, typeof token === 'string' ? token : undefined)) {
      return reject(req, res, 403, { error: 'Only the host of this room can do this.' });
    }
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      raw += c;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let link = '';
      let audio = false;
      try {
        const body = JSON.parse(raw) as { url?: unknown; audio?: unknown };
        link = String(body.url ?? '').trim();
        audio = body.audio === true;
      } catch {
        /* not JSON: rejected just below */
      }
      const torrent = isTorrentLink(link);
      if ((!torrent && !/^https?:\/\/\S+$/i.test(link)) || link.length > 2000) {
        return send(res, 400, { error: 'Paste a full http(s) link to a video, or a torrent link.' });
      }
      if (!torrent && !ytdlpAvailable()) return send(res, 501, { error: 'yt-dlp must be installed on the server for this.' });
      if (totalBytes() >= opts.maxTotalBytes) return send(res, 507, { error: 'The server is out of space for hosted videos. Try again later.' });
      // already fetched for this room (a preloaded next song, a replay, "previous"): hand back that copy at once
      const have = [...items.values()].find((i) => i.room === room && i.source === link && i.audio === audio && i.state !== 'error');
      if (have) {
        have.createdAt = Date.now(); // recently used: last in line to be dropped for space
        return send(res, 200, { id: have.id, reused: true });
      }
      // a magnet link is unreadable as a name: a torrent shows "Torrent" until its real name is known (on metadata)
      const item = makeItem(room, torrent ? 'Torrent' : link.slice(0, 120), 'downloading', 0);
      item.source = link;
      item.audio = audio;
      if (torrent) downloadTorrent(item, link);
      else download(item, link, audio);
      send(res, 200, { id: item.id });
    });
  }

  /** `audio`: music mode, only the best sound (a few MB, ready in seconds) instead of up to 1080p video */
  function download(item: Item, link: string, audio: boolean): void {
    const dir = dirOf(item.id);
    const args = [
      '--no-playlist', '--newline', '--no-colors', '--progress', '--no-simulate',
      ...(audio ? ['-f', 'bestaudio/best'] : ['-f', 'bv*[height<=1080]+ba/b[height<=1080]/b', '--merge-output-format', 'mkv']),
      '--max-filesize', String(opts.maxBytes),
      '--print', 'before_dl:TITLE %(title)s',
      '--progress-template', 'download:PROGRESS %(progress._percent_str)s',
      '-o', join(dir, 'download.%(ext)s'),
    ];
    if (opts.ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', opts.ffmpeg);
    args.push('--', link);
    const proc = spawn(opts.ytdlp, args, { windowsHide: true });
    item.proc = proc;

    let pending = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (c: string) => {
      const lines = (pending + c).split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const title = line.match(/^TITLE (.+)$/);
        if (title) item.name = title[1]!.trim().slice(0, 120);
        // video and audio download one after the other, so this runs 0-100% twice; good enough for a progress bar
        const pct = line.match(/^PROGRESS\s+([\d.]+)%/);
        if (pct) item.progress = Math.min(1, Number(pct[1]) / 100);
      }
    });
    let errTail = '';
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (c: string) => {
      errTail = (errTail + c).slice(-2000);
    });
    proc.on('error', () => {
      errTail = 'Could not start yt-dlp.';
    });
    proc.on('close', (code) => {
      item.proc = null;
      if (!items.has(item.id)) return; // removed while downloading
      const file = code === 0 ? readdirSync(dir).find((f) => f.startsWith('download.') && !/\.(part|ytdl|temp)$/.test(f)) : undefined;
      if (!file) {
        const lines = errTail.split('\n').map((l) => l.trim()).filter(Boolean);
        item.state = 'error';
        item.error = `yt-dlp could not get this video. ${lines.filter((l) => l.startsWith('ERROR')).pop() ?? lines.pop() ?? ''}`.trim();
        return;
      }
      ready(item, join(dir, file));
    });
  }

  /** A finished download (`file`, a path) becomes the item's source and waits its turn for conversion. */
  function ready(item: Item, file: string): void {
    const source = join(dirOf(item.id), 'source');
    renameSync(file, source);
    item.bytes = statSync(source).size;
    if (totalBytes() > opts.maxTotalBytes) {
      rmSync(source, { force: true });
      item.bytes = 0;
      item.state = 'error';
      item.error = 'The server is out of space for hosted videos. Try again later.';
      return;
    }
    item.progress = 0;
    item.state = 'queued';
    queue.push(item.id);
    pump();
  }

  /**
   * A torrent (magnet link or .torrent file). Only the biggest video or audio file in it is downloaded; the rest
   * are skipped. Like yt-dlp, the finished file is converted afterwards, so playback starts once it is complete.
   * Nobody sharing it for 2 minutes is an error, so a dead torrent does not wait forever.
   */
  function downloadTorrent(item: Item, link: string): void {
    const folder = join(dirOf(item.id), 'torrent');
    let torrent: Torrent;
    try {
      torrent = torrentClient().add(link, { path: folder });
    } catch (e) {
      item.state = 'error';
      item.error = `That torrent link could not be read. ${(e as Error).message}`;
      return;
    }
    let gotInfo = false;
    let wanted: TorrentFile | null = null;
    const fail = (message: string): void => {
      clearTimeout(noPeers);
      clearInterval(monitor);
      item.cancel = null;
      torrent.destroy();
      if (!items.has(item.id)) return; // removed while downloading
      item.state = 'error';
      item.error = message;
    };
    const noPeers = setTimeout(() => {
      if (!gotInfo) fail('Nobody is sharing this torrent right now (no peers answered in 2 minutes).');
    }, 120_000);
    item.cancel = () => {
      clearTimeout(noPeers);
      clearInterval(monitor);
      torrent.destroy();
    };
    // once a second: the peers and speed the page shows; and a log line every 5 seconds, for finding slow downloads
    let ticks = 0;
    const monitor = setInterval(() => {
      item.peers = torrent.numPeers;
      item.rate = torrent.downloadSpeed;
      if (++ticks % 5 !== 0) return;
      console.log(`[torrent ${item.id.slice(0, 8)}] ${Math.round(torrent.progress * 100)}% · ${torrent.numPeers} peers · ${Math.round(torrent.downloadSpeed / 1024)} KB/s`);
    }, 1000);
    torrent.on('error', (err) => fail(`The torrent could not be downloaded. ${err instanceof Error ? err.message : String(err)}`));
    torrent.once('metadata', () => {
      gotInfo = true;
      clearTimeout(noPeers);
      const media = torrent.files.filter((f) => MEDIA_FILE.test(f.name)).sort((a, b) => b.length - a.length)[0];
      if (!media) return fail('This torrent has no video or audio file in it.');
      if (media.length > opts.maxBytes) return fail(`This file is larger than the server's limit (${Math.round(opts.maxBytes / 1024 / 1024)} MB).`);
      if (totalBytes() + media.length > opts.maxTotalBytes) return fail('The server is out of space for hosted videos. Try again later.');
      wanted = media;
      for (const f of torrent.files) if (f !== media) f.deselect();
      item.name = torrent.name.slice(0, 120);
      item.bytes = media.length;
    });
    torrent.on('download', () => {
      item.progress = torrent.progress;
    });
    torrent.once('done', () => {
      if (!wanted || !items.has(item.id)) return;
      const file = join(folder, wanted.path);
      item.cancel = null;
      clearTimeout(noPeers);
      clearInterval(monitor);
      // stop sharing and close the file before it is moved; the folder is only needed until then
      torrent.destroy({}, () => {
        if (!items.has(item.id)) return; // removed while closing
        ready(item, file);
        rmSync(folder, { recursive: true, force: true });
      });
    });
  }

  /** PUT /api/media?room=CODE&name=file.mkv   (header x-host-token, raw file as the body) */
  function upload(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!available) return reject(req, res, 501, { error: 'This server has no ffmpeg installed, so it cannot host videos.' });
    const room = (url.searchParams.get('room') ?? '').toUpperCase();
    const token = req.headers['x-host-token'];
    if (!/^[A-Z0-9]{4,10}$/.test(room) || !opts.isHost(room, typeof token === 'string' ? token : undefined)) {
      return reject(req, res, 403, { error: 'Only the host of this room can upload.' });
    }
    const len = Number(req.headers['content-length'] ?? 0);
    if (!len) return reject(req, res, 411, { error: 'Missing file size.' });
    if (len > opts.maxBytes) return reject(req, res, 413, { error: `File too large (limit ${Math.round(opts.maxBytes / 1024 / 1024)} MB).` });
    if (totalBytes() + len > opts.maxTotalBytes) return reject(req, res, 507, { error: 'The server is out of space for hosted videos. Try again later.' });

    const item = makeItem(room, (url.searchParams.get('name') ?? 'video').slice(0, 120), 'uploading', len);
    const id = item.id;

    const out = createWriteStream(join(dirOf(id), 'source'));
    let received = 0;
    let finished = false;
    req.on('data', (c: Buffer) => {
      received += c.length;
      if (received > opts.maxBytes) {
        req.destroy();
        remove(id);
      }
    });
    req.pipe(out);
    out.on('finish', () => {
      if (!items.has(id) || received !== len) return remove(id);
      finished = true;
      item.state = 'queued';
      queue.push(id);
      send(res, 200, { id });
      pump();
    });
    // The browser cancelled or the connection dropped half way. Note: Node also emits 'close' after a
    // request that completed normally, so only act if the body never finished arriving.
    req.on('close', () => {
      if (!req.complete && !finished && items.has(id) && item.state === 'uploading') remove(id);
    });
    out.on('error', () => {
      remove(id);
      send(res, 500, { error: 'Could not save the upload.' });
    });
  }

  /** how many chunks the least-advanced playlist has so far (the player needs a couple of each) */
  function readySegments(item: Item): number {
    const count = (file: string): number => (item.lists.get(file)?.toString().match(/^seg_[\w-]+\.ts$/gm) ?? []).length;
    if (item.expectedVariants === 0) return count('index.m3u8');
    const lists = [...item.lists.keys()].filter((f) => /^stream_.+\.m3u8$/.test(f));
    if (lists.length < item.expectedVariants) return 0;
    return Math.min(...lists.map(count));
  }

  function status(res: ServerResponse, id: string): void {
    const item = items.get(id);
    if (!item) return send(res, 404, { error: 'Not found (it may have expired).' });
    const segments = readySegments(item);
    send(res, 200, {
      state: item.state,
      progress: item.progress,
      // playback can start once a couple of chunks of every stream exist, while the rest is still converting
      playable: item.state === 'done' || (item.state === 'converting' && segments >= 2),
      segments,
      entry: item.entry,
      duration: item.duration,
      name: item.name,
      error: item.error,
      // torrents: how many peers are connected, the download speed (bytes/s), and how fast ffmpeg converts
      peers: item.peers,
      rate: item.rate,
      speed: item.ffSpeed,
    });
  }

  const TYPES: Record<string, string> = {
    m3u8: 'application/vnd.apple.mpegurl',
    ts: 'video/mp2t',
    vtt: 'text/vtt; charset=utf-8',
    json: 'application/json',
  };

  /** GET /media/<id>/index.m3u8 | master.m3u8 | stream_*.m3u8 | seg_*.ts | sub_N.vtt | tracks.json */
  function serve(req: IncomingMessage, res: ServerResponse, id: string, file: string): void {
    const item = items.get(id);
    const ok = /^(index\.m3u8|master\.m3u8|stream_[\w-]+\.m3u8|seg_[\w-]+\.ts|sub_\d+\.vtt|tracks\.json)$/.test(file);
    if (!item || !ok) return send(res, 404, { error: 'not found' });
    const path = join(dirOf(id), file);
    const ext = file.slice(file.lastIndexOf('.') + 1);
    if (ext === 'm3u8') {
      // playlists come from memory: always a whole, consistent file, and never a file handle that could block ffmpeg
      const buf = item.lists.get(file);
      if (!buf) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': TYPES.m3u8!, 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'content-length': String(buf.length) });
      res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    if (!existsSync(path)) return send(res, 404, { error: 'not found' });
    const live = ext === 'm3u8' || file === 'tracks.json';
    const size = statSync(path).size;
    const headers: Record<string, string> = {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': live ? 'no-store' : 'public, max-age=86400, immutable',
      'access-control-allow-origin': '*',
      'accept-ranges': 'bytes',
    };
    const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${size}` });
        return void res.end();
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    createReadStream(path).pipe(res);
  }

  function cleanupRoom(room: string): void {
    for (const [id, item] of items) if (item.room === room) remove(id);
  }

  setInterval(() => {
    const now = Date.now();
    for (const [id, item] of items) if (now - item.createdAt > opts.ttlMs) remove(id);
  }, 5 * 60_000).unref();

  return { available: () => available, ytdlpAvailable, maxBytes: opts.maxBytes, upload, fetchUrl, status, serve, cleanupRoom };
}
