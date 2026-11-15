// Node backend: the same rooms as the Cloudflare Worker, in one plain process.
//   pnpm dev            (web + this server)      pnpm start   (after `pnpm build`, serves the web app too)
// Rooms live in memory only. Restarting this process closes every room, nothing is written to disk.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomCore, iceServers, makeCode, type WebSocketLike } from '@wp/room';
import { createMedia } from './media.js';
import { createYt, type YtList } from './yt.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0'; // reachable from other devices on the Wi-Fi
const MAX_ROOMS = 2000;
const WEB_DIST = resolve(fileURLToPath(new URL('../../web/dist', import.meta.url)));

interface Entry {
  core: RoomCore;
  timer?: NodeJS.Timeout;
}
const rooms = new Map<string, Entry>();

function getRoom(code: string): Entry | null {
  const existing = rooms.get(code);
  if (existing) return existing;
  if (rooms.size >= MAX_ROOMS) return null;
  const entry = {} as Entry;
  entry.core = new RoomCore({
    // the host runtime's "wipe this room if still empty after the grace period"
    setAlarm: (ms) => {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        entry.core.onAlarm();
        if (!entry.core.isCreated()) {
          rooms.delete(code);
          media.cleanupRoom(code); // hosted videos go away with the room
          for (const [id, img] of chatImages) {
            // and so do chat pictures (keeping the running total right, or the 300 MB cap would wipe new uploads)
            if (img.room !== code) continue;
            chatImageBytes -= img.data.length;
            chatImages.delete(id);
          }
        }
      }, ms);
    },
    clearAlarm: () => clearTimeout(entry.timer),
  });
  entry.core.setCode(code);
  rooms.set(code, entry);
  return entry;
}

// Portable tools shipped with the project win over anything installed on the machine:
//   tools/ffmpeg/ffmpeg[.exe], tools/ffmpeg/ffprobe[.exe], tools/yt-dlp/yt-dlp[.exe]  (or flat: tools/ffmpeg[.exe], …)
// Order: an environment variable (FFMPEG_PATH, FFPROBE_PATH, YTDLP_PATH), then tools/, then the npm packages
// (ffmpeg, ffprobe), then the system PATH. `pnpm setup-tools` puts yt-dlp (and cloudflared) in tools/.
const TOOLS = resolve(fileURLToPath(new URL('../../../tools', import.meta.url)));
// 2nd choice after tools/: the ffmpeg / ffprobe npm packages installed by `pnpm install` for this OS and CPU
const requireHere = createRequire(import.meta.url);
function fromNpm(pkg: string, pick: (m: unknown) => unknown): string | null {
  try {
    const p = pick(requireHere(pkg));
    return typeof p === 'string' && existsSync(p) ? p : null;
  } catch {
    return null; // not installed: fall back to the PATH
  }
}
function tool(name: string, folder: string, envVar: string, npm?: () => string | null): { path: string; bundled: boolean } {
  const fromEnv = process.env[envVar];
  if (fromEnv) return { path: fromEnv, bundled: false };
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const candidate of [join(TOOLS, folder, exe), join(TOOLS, exe)]) {
    if (existsSync(candidate)) return { path: candidate, bundled: true };
  }
  const packaged = npm?.();
  if (packaged) return { path: packaged, bundled: false };
  return { path: name, bundled: false };
}
const FFMPEG = tool('ffmpeg', 'ffmpeg', 'FFMPEG_PATH', () => fromNpm('ffmpeg-static', (m) => m));
const FFPROBE = tool('ffprobe', 'ffmpeg', 'FFPROBE_PATH', () => fromNpm('@ffprobe-installer/ffprobe', (m) => (m as { path?: string }).path));
const YTDLP = tool('yt-dlp', 'yt-dlp', 'YTDLP_PATH');
console.log(`[server] tools: ffmpeg=${FFMPEG.path}  ffprobe=${FFPROBE.path}  yt-dlp=${YTDLP.path}`);
// YouTube changes often and an old yt-dlp stops working: the standalone yt-dlp.exe updates itself (quietly, in
// the background, so start-up is not held up)
if (YTDLP.bundled) {
  spawn(YTDLP.path, ['-U'], { windowsHide: true, stdio: 'ignore' }).on('error', () => undefined);
}

// YouTube-style hosting of uploaded videos (needs ffmpeg + ffprobe; see media.ts)
const media = createMedia({
  dir: process.env.MEDIA_DIR ?? resolve(fileURLToPath(new URL('../.media', import.meta.url))),
  ffmpeg: FFMPEG.path,
  ffprobe: FFPROBE.path,
  maxBytes: Number(process.env.MAX_UPLOAD_MB ?? 4096) * 1024 * 1024,
  maxTotalBytes: Number(process.env.MAX_MEDIA_GB ?? 20) * 1024 * 1024 * 1024,
  ttlMs: Number(process.env.MEDIA_TTL_HOURS ?? 6) * 3_600_000,
  // a few videos, or a run of songs: the current one, the preloaded next ones, and recent ones for replay
  perRoom: Number(process.env.MEDIA_PER_ROOM ?? 8),
  qualities: process.env.MEDIA_QUALITIES === 'original' ? 'original' : 'auto',
  ytdlp: YTDLP.path,
  isHost: (room, token) => !!rooms.get(room)?.core.isHostToken(token),
});

// YouTube search, playlists and suggestions for the Queue tab (yt-dlp, no API key; see yt.ts)
const yt = createYt(YTDLP.path);

// GIF search for the chat. Giphy and Tenor are free but need a key (GIPHY_KEY or TENOR_KEY); without one the
// chat still takes GIF links and files. Answers are cached for 10 minutes.
interface Gif {
  preview: string;
  url: string;
  title: string;
}
const gifCache = new Map<string, { at: number; results: Gif[] }>();
async function searchGifs(q: string): Promise<Gif[]> {
  const key = q.toLowerCase();
  const hit = gifCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.results;
  let results: Gif[] = [];
  if (process.env.GIPHY_KEY) {
    const base = 'https://api.giphy.com/v1/gifs/';
    const params = new URLSearchParams({ api_key: process.env.GIPHY_KEY, limit: '24', rating: 'pg-13', ...(q ? { q } : {}) });
    const r = await fetch(`${base}${q ? 'search' : 'trending'}?${params}`);
    if (!r.ok) throw new Error(`giphy ${r.status}`);
    const j = (await r.json()) as { data?: Array<{ title?: string; images?: Record<string, { url?: string }> }> };
    results = (j.data ?? [])
      .map((g) => ({ preview: g.images?.fixed_height_small?.url ?? '', url: g.images?.downsized?.url ?? g.images?.original?.url ?? '', title: g.title ?? '' }))
      .filter((g) => g.preview && g.url);
  } else if (process.env.TENOR_KEY) {
    const params = new URLSearchParams({ key: process.env.TENOR_KEY, client_key: 'couchline', limit: '24', media_filter: 'gif,tinygif', contentfilter: 'medium', ...(q ? { q } : {}) });
    const r = await fetch(`https://tenor.googleapis.com/v2/${q ? 'search' : 'featured'}?${params}`);
    if (!r.ok) throw new Error(`tenor ${r.status}`);
    const j = (await r.json()) as { results?: Array<{ content_description?: string; media_formats?: Record<string, { url?: string }> }> };
    results = (j.results ?? [])
      .map((g) => ({ preview: g.media_formats?.tinygif?.url ?? '', url: g.media_formats?.gif?.url ?? '', title: g.content_description ?? '' }))
      .filter((g) => g.preview && g.url);
  }
  gifCache.set(key, { at: Date.now(), results });
  if (gifCache.size > 300) gifCache.clear();
  return results;
}

async function ytRoute(res: ServerResponse, valid: boolean, run: () => Promise<YtList>): Promise<void> {
  if (!media.ytdlpAvailable()) return json(res, { error: 'yt-dlp is not installed on this server.' }, 501);
  if (!valid) return json(res, { error: 'Bad request.' }, 400);
  try {
    json(res, await run());
  } catch {
    json(res, { error: 'YouTube did not answer. Try again in a moment.' }, 502);
  }
}

// Pictures and GIFs people share in chat: kept in memory while their room lives (oldest dropped past 300 MB).
const chatImages = new Map<string, { room: string; type: string; data: Buffer }>();
const CHAT_IMAGE_MAX = 8 * 1024 * 1024;
let chatImageBytes = 0;

function uploadChatImage(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const room = (url.searchParams.get('room') ?? '').toUpperCase();
  const type = String(req.headers['content-type'] ?? '');
  if (!/^[A-Z0-9]{4,10}$/.test(room) || !rooms.get(room)?.core.isCreated()) return json(res, { error: 'That room does not exist.' }, 404);
  if (!/^image\/(png|jpeg|gif|webp)$/.test(type)) return json(res, { error: 'Only PNG, JPEG, GIF and WebP pictures can be shared.' }, 415);
  if (Number(req.headers['content-length'] ?? 0) > CHAT_IMAGE_MAX) return json(res, { error: 'That picture is over 8 MB.' }, 413);
  const parts: Buffer[] = [];
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > CHAT_IMAGE_MAX) req.destroy();
    else parts.push(c);
  });
  req.on('end', () => {
    if (size === 0 || size > CHAT_IMAGE_MAX) return json(res, { error: 'That picture is over 8 MB.' }, 413);
    const id = randomUUID();
    chatImages.set(id, { room, type, data: Buffer.concat(parts) });
    chatImageBytes += size;
    for (const [old, img] of chatImages) {
      if (chatImageBytes <= 300 * 1024 * 1024) break;
      chatImageBytes -= img.data.length;
      chatImages.delete(old);
    }
    json(res, { url: `/chat-image/${id}` });
  });
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serves the built web app (apps/web/dist) so one process can host everything. */
function serveStatic(pathname: string, res: ServerResponse): void {
  if (!existsSync(WEB_DIST)) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Web app not built. In dev, open the Vite URL (http://localhost:5173). For one-process hosting run `pnpm build` first.');
    return;
  }
  const safe = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  let file = join(WEB_DIST, safe);
  if (!file.startsWith(WEB_DIST + sep) && file !== WEB_DIST) file = join(WEB_DIST, 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIST, 'index.html'); // SPA fallback
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'cache-control': file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(res);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = async (): Promise<void> => {
    if (url.pathname === '/api/health') {
      const ytdlp = media.ytdlpAvailable();
      const gifs = !!(process.env.GIPHY_KEY || process.env.TENOR_KEY);
      // api: bumped whenever the page needs newer server features; the page warns when they do not match
      return json(res, { ok: true, backend: 'node', api: 3, rooms: rooms.size, media: { available: media.available(), maxMB: Math.round(media.maxBytes / 1024 / 1024), ytdlp }, gifs });
    }
    if (url.pathname === '/api/media' && req.method === 'PUT') return media.upload(req, res, url);
    // yt-dlp: any room host may use it (a private server). It still needs the room's host token.
    if (url.pathname === '/api/media/fetch' && req.method === 'POST') return media.fetchUrl(req, res, url);
    if (url.pathname === '/api/yt/check') {
      if (!media.ytdlpAvailable()) return json(res, { error: 'This server has no yt-dlp, so it can only play YouTube links and direct video files.' }, 501);
      const link = (url.searchParams.get('url') ?? '').trim();
      if (!/^https:\/\/\S+$/i.test(link) || link.length > 2000) return json(res, { error: 'Paste a full https link.' }, 400);
      try {
        return json(res, await yt.check(link));
      } catch (e) {
        return json(res, { error: (e as Error).message }, 422);
      }
    }
    if (url.pathname === '/api/yt/search') {
      const q = (url.searchParams.get('q') ?? '').trim();
      return ytRoute(res, q.length > 0 && q.length <= 120, () => yt.search(q));
    }
    if (url.pathname === '/api/yt/playlist') {
      const list = url.searchParams.get('list') ?? '';
      return ytRoute(res, /^[\w-]{10,64}$/.test(list), () => yt.playlist(list));
    }
    if (url.pathname === '/api/yt/related') {
      const v = url.searchParams.get('v') ?? '';
      return ytRoute(res, /^[\w-]{11}$/.test(v), () => yt.related(v));
    }
    const mediaStatus = url.pathname.match(/^\/api\/media\/([0-9a-f-]{36})$/);
    if (mediaStatus && req.method === 'GET') return media.status(res, mediaStatus[1]!);
    const mediaFile = url.pathname.match(/^\/media\/([0-9a-f-]{36})\/([\w.]+)$/);
    if (mediaFile && (req.method === 'GET' || req.method === 'HEAD')) return media.serve(req, res, mediaFile[1]!, mediaFile[2]!);
    if (url.pathname === '/api/gif/search') {
      if (!process.env.GIPHY_KEY && !process.env.TENOR_KEY) return json(res, { error: 'GIF search needs a free GIPHY_KEY or TENOR_KEY on the server.' }, 501);
      const q = (url.searchParams.get('q') ?? '').trim().slice(0, 80);
      try {
        return json(res, { results: await searchGifs(q) });
      } catch {
        return json(res, { error: 'The GIF service did not answer. Try again in a moment.' }, 502);
      }
    }
    if (url.pathname === '/api/chat-image' && req.method === 'PUT') return uploadChatImage(req, res, url);
    const chatImage = url.pathname.match(/^\/chat-image\/([0-9a-f-]{36})$/);
    if (chatImage) {
      const img = chatImages.get(chatImage[1]!);
      if (!img) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'content-type': img.type, 'content-length': String(img.data.length), 'cache-control': 'private, max-age=86400' });
      res.end(img.data);
      return;
    }
    if (url.pathname === '/api/rooms' && req.method === 'POST') return json(res, { code: makeCode() });
    if (url.pathname === '/api/ice') return json(res, await iceServers(process.env));
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return json(res, { error: 'not found' }, 404);
    serveStatic(url.pathname, res);
  };
  route().catch(() => {
    if (!res.headersSent) json(res, { error: 'internal error' }, 500);
    else res.end();
  });
});

server.requestTimeout = 0; // a big upload on a slow connection can take far longer than Node's 5-minute default

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
const alive = new WeakSet<WebSocket>();

server.on('upgrade', (req, socket, head) => {
  const m = new URL(req.url ?? '/', 'http://localhost').pathname.match(/^\/ws\/([A-Z0-9]{4,10})$/);
  if (!m) {
    socket.destroy();
    return;
  }
  const code = m[1]!;
  wss.handleUpgrade(req, socket, head, (ws) => {
    const entry = getRoom(code);
    if (!entry) {
      ws.close(1013, 'server busy');
      return;
    }
    alive.add(ws);
    ws.on('pong', () => alive.add(ws));
    // drop the room object once it is truly gone (never created, or wiped), so probes cannot pile up
    ws.on('close', () => setTimeout(() => !entry.core.isCreated() && rooms.get(code) === entry && rooms.delete(code), 0));
    entry.core.attach(ws as unknown as WebSocketLike);
  });
});

// heartbeat: phones and sleeping laptops vanish without closing the socket
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.has(ws)) {
      ws.terminate();
      continue;
    }
    alive.delete(ws);
    try {
      ws.ping();
    } catch {
      /* ignore */
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${PORT}`);
  console.log(`[server] rooms backend ready on http://localhost:${PORT}`);
  if (lan.length) console.log(`[server] on your network: ${lan.join('  ')}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    wss.close();
    server.close();
    process.exit(0);
  });
}
