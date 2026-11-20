// Torrent hosting, end to end and offline: a local tracker and a local seeder stand in for the public swarm.
// The test starts its own server (port 8798), seeds a short test video, and asks the server to host it from a
// magnet link, the same way the host's page does. Nothing is sent to the internet.
//   node scripts/e2e-torrent.mjs
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../apps/server', import.meta.url));
const PORT = 8798;
const TRACKER_PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + x}`);
  if (!ok) failures++;
};

// the server's own dependencies (pnpm keeps them inside apps/server)
const require = createRequire(join(SERVER, 'package.json'));
const { default: WebTorrent } = await import(new URL('../apps/server/node_modules/webtorrent/index.js', import.meta.url).href);
const { Server: Tracker } = await import(new URL('../apps/server/node_modules/bittorrent-tracker/index.js', import.meta.url).href);
const ffmpeg = require('ffmpeg-static');

const work = mkdtempSync(join(tmpdir(), 'couchline-torrent-'));
const video = join(work, 'film.mp4');
const made = spawnSync(
  ffmpeg,
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video],
  { timeout: 120_000 },
);
if (made.status !== 0) {
  console.error('could not make the test video:', String(made.stderr));
  process.exit(1);
}

const tracker = new Tracker({ udp: false, ws: false, http: true });
await new Promise((r) => tracker.listen(TRACKER_PORT, '127.0.0.1', r));

const seeder = new WebTorrent({ dht: false, lsd: false });
const magnet = await new Promise((resolve, reject) => {
  seeder.on('error', reject);
  seeder.seed(readFileSync(video), { name: 'film.mp4', announce: [`http://127.0.0.1:${TRACKER_PORT}/announce`] }, (t) => resolve(t.magnetURI));
});

const server = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
  cwd: SERVER,
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', MEDIA_DIR: join(work, 'media') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));
const ready = Date.now() + 60_000;
while (!serverLog.includes('rooms backend ready') && Date.now() < ready) await sleep(200);

let ws = null;
try {
  if (!serverLog.includes('rooms backend ready')) throw new Error(`the server did not start:\n${serverLog}`);

  // a room, and its host token (the welcome message for the person who created the room)
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  const hostToken = await new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/${code}`);
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nick: 'Tester', sessionId: 'torrent-e2e-host-01', create: true }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.t === 'welcome') resolve(msg.hostToken);
    };
    ws.onerror = () => reject(new Error('could not join the room'));
  });

  const ask = (token, body) =>
    fetch(`${BASE}/api/media/fetch?room=${code}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-host-token': token },
      body: JSON.stringify(body),
    });

  const denied = await ask('not-the-host', { url: magnet });
  check('someone who is not the host cannot add a torrent (403)', denied.status === 403, String(denied.status));

  const notALink = await ask(hostToken, { url: 'ftp://example.com/film.torrent' });
  check('a link that is not http(s) or a torrent is refused (400)', notALink.status === 400, String(notALink.status));

  const started = await ask(hostToken, { url: magnet });
  const { id, error } = await started.json();
  check('the host can start a torrent from a magnet link', started.ok && !!id, error ?? '');

  const deadline = Date.now() + 180_000;
  let st = null;
  while (id && Date.now() < deadline) {
    st = await (await fetch(`${BASE}/api/media/${id}`)).json();
    if (st.state === 'done' || st.state === 'error') break;
    await sleep(1000);
  }
  check('the torrent downloads and converts for playing', st?.state === 'done', JSON.stringify(st));
  check('the room shows the torrent name, not the magnet text', st?.name === 'film.mp4', JSON.stringify(st?.name));

  if (st?.state === 'done') {
    const list = await fetch(`${BASE}/media/${id}/${st.entry}`);
    const text = await list.text();
    check('the hosted copy has a playlist viewers can open', list.ok && text.startsWith('#EXTM3U'), String(list.status));
    check('the torrent folder is cleaned up after the download', !existsSync(join(work, 'media', id, 'torrent')));
  }

  const again = await ask(hostToken, { url: magnet });
  const reused = await again.json();
  check('the same torrent is handed back at once, not downloaded twice', again.ok && reused.reused === true && reused.id === id, JSON.stringify(reused));
} catch (e) {
  check('the torrent test ran to the end', false, e.message);
} finally {
  ws?.close();
  server.kill();
  await new Promise((r) => seeder.destroy(() => r()));
  await new Promise((r) => tracker.close(r));
  if (failures) console.log('\nserver log:\n' + serverLog.slice(-2000));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll torrent checks passed');
process.exit(failures ? 1 : 0);
