import type { LinkKind, QueueItem, RoomPhase, StreamInfo, SyncState } from './types';

/** Current playback position implied by a sync record, given the server clock. */
export function computePosition(sync: SyncState, serverNow: number): number {
  if (!sync.playing) return sync.position;
  return sync.position + Math.max(0, serverNow - sync.updatedAt) / 1000;
}

/** Viewers may rewind but never pass the live edge. */
export function clampSeek(target: number, min: number, liveEdge: number): number {
  if (!Number.isFinite(target)) return liveEdge;
  return Math.min(Math.max(target, min), liveEdge);
}

export function roomPhase(sync: SyncState, stream: StreamInfo): RoomPhase {
  if (sync.mode !== 'stream') return 'LINK_ACTIVE';
  return stream.live ? 'STREAM_LIVE' : 'STREAM_HOST_AWAY';
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type ParsedLink =
  | { ok: true; kind: LinkKind; url: string; videoId: string | null }
  | { ok: false; error: string };

const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const YT_ID = /^[\w-]{11}$/;
const FILE_EXT = /\.(mp4|webm|ogv|mov|m4v)$/i;

/** localhost and private-network addresses: plain http is fine there (home Wi-Fi testing, a self-hosted server). */
function isPrivateHost(h: string): boolean {
  return h === 'localhost' || /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

/** A BitTorrent link: a magnet link with an info hash, or a .torrent file on an https address. */
export function isTorrentLink(raw: string): boolean {
  const s = raw.trim();
  if (/^magnet:\?/i.test(s)) return /[?&]xt=urn:btih:/i.test(s);
  return /^https:\/\/\S+\.torrent(\?\S*)?$/i.test(s);
}

/** Allowlist: YouTube links, direct video files and torrents. Anything else is rejected. */
export function parseLink(raw: string): ParsedLink {
  // a torrent is fetched by the host's page, like any other site link (see HostedUpload and media.ts)
  if (isTorrentLink(raw)) return { ok: true, kind: 'site', url: raw.trim(), videoId: null };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: 'That is not a valid link.' };
  }
  const local = isPrivateHost(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) {
    return { ok: false, error: 'Only https links are allowed.' };
  }
  if (YT_HOSTS.has(u.hostname)) {
    let id: string | null = null;
    if (u.hostname === 'youtu.be') id = u.pathname.slice(1).split('/')[0] ?? null;
    else if (u.pathname === '/watch') id = u.searchParams.get('v');
    else {
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) id = m[1] ?? null;
    }
    if (id && YT_ID.test(id)) {
      return { ok: true, kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, videoId: id };
    }
    return { ok: false, error: 'Could not find a YouTube video id in that link.' };
  }
  if (/\.m3u8$/i.test(u.pathname)) {
    return { ok: true, kind: 'hls', url: u.toString(), videoId: null };
  }
  if (FILE_EXT.test(u.pathname)) {
    return { ok: true, kind: 'file', url: u.toString(), videoId: null };
  }
  // Any other https page may be a site yt-dlp knows (Vimeo, Twitch, SoundCloud, …). It cannot play directly:
  // the host's page fetches it with yt-dlp, and yt-dlp itself says whether the link is usable.
  if (u.protocol === 'https:') return { ok: true, kind: 'site', url: u.toString(), videoId: null };
  return { ok: false, error: 'Supported: YouTube links, direct .mp4 / .webm / .mov files, .m3u8 streams, and other https video pages.' };
}

const BAD_WORDS = ['fuck', 'shit', 'bitch', 'asshole', 'cunt', 'nigger', 'faggot'];
const BAD_RE = new RegExp(`(${BAD_WORDS.join('|')})`, 'gi');

/** Very small profanity mask. Not a moderation system, just a speed bump. */
export function filterText(text: string): string {
  return text.replace(BAD_RE, (m) => '*'.repeat(m.length));
}

const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75];

/** Index of a WebM Cluster element ID in `buf`, or -1. `last` finds the final occurrence. */
export function findCluster(buf: Uint8Array, last = false): number {
  const n = buf.length - 4;
  if (last) {
    for (let i = n; i >= 0; i--) if (isCluster(buf, i)) return i;
  } else {
    for (let i = 0; i <= n; i++) if (isCluster(buf, i)) return i;
  }
  return -1;
}

function isCluster(b: Uint8Array, i: number): boolean {
  return b[i] === CLUSTER_ID[0] && b[i + 1] === CLUSTER_ID[1] && b[i + 2] === CLUSTER_ID[2] && b[i + 3] === CLUSTER_ID[3];
}

/** Queue order: most votes first, ties keep insertion order. */
export function sortQueue(queue: QueueItem[]): QueueItem[] {
  return queue
    .map((q, i) => ({ q, i }))
    .sort((a, b) => b.q.votes.length - a.q.votes.length || a.i - b.i)
    .map((x) => x.q);
}

export interface Cue {
  start: number;
  end: number;
  text: string;
}

/** Parse SRT or VTT text into cues. */
export function parseSubtitles(src: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = src.replace(/\r/g, '').split(/\n{2,}/);
  const ts = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})|(\d{1,2}):(\d{2})[.,](\d{1,3})/;
  const toSec = (s: string): number => {
    const m = s.match(ts);
    if (!m) return NaN;
    if (m[1] !== undefined) return +m[1] * 3600 + +m[2]! * 60 + +m[3]! + +m[4]!.padEnd(3, '0') / 1000;
    return +m[5]! * 60 + +m[6]! + +m[7]!.padEnd(3, '0') / 1000;
  };
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => l.includes('-->'));
    if (idx < 0) continue;
    const [a, b] = lines[idx]!.split('-->');
    const start = toSec(a!.trim());
    const end = toSec(b!.trim().split(/\s+/)[0]!);
    const text = lines
      .slice(idx + 1)
      .join('\n')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (Number.isFinite(start) && Number.isFinite(end) && text) cues.push({ start, end, text });
  }
  return cues;
}
