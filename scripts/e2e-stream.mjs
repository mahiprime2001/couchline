// Real-browser test of host-stream mode: host file -> MediaRecorder -> room server -> MSE -> rewind-only.
// Needs `pnpm dev` running (web on :5173, worker on :8787) and Chrome or Edge installed.
//   node scripts/e2e-stream.mjs
import { chromium } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const CHANNEL = process.env.CHANNEL ?? 'chrome';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: CHANNEL,
  headless: true,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--use-fake-ui-for-media-stream',
  ],
});

// ---- 1. generate a 14s animated test video (with an audio track) using Chrome itself
const gen = await (await browser.newContext()).newPage();
await gen.goto('about:blank');
const b64 = await gen.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const g = c.getContext('2d');
  const ac = new AudioContext();
  const osc = ac.createOscillator();
  const dest = ac.createMediaStreamDestination();
  osc.connect(dest);
  osc.start();
  const stream = c.captureStream(30);
  dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
  const chunks = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  rec.start(500);
  const t0 = performance.now();
  await new Promise((res) => {
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      g.fillStyle = `hsl(${(t * 40) % 360},70%,40%)`;
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff';
      g.font = '80px sans-serif';
      g.fillText(t.toFixed(1), 220, 200);
      t < 14 ? requestAnimationFrame(draw) : res();
    };
    draw();
  });
  rec.stop();
  await new Promise((r) => (rec.onstop = r));
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
});
const videoPath = join(mkdtempSync(join(tmpdir(), 'wp-e2e-')), 'test-video.webm');
writeFileSync(videoPath, Buffer.from(b64, 'base64'));
console.log(`generated test video: ${videoPath} (${(b64.length * 0.75 / 1024).toFixed(0)} KB)`);

// ---- 2. host creates a room and streams the file
const hostCtx = await browser.newContext();
await hostCtx.addInitScript(() => {
  delete window.showOpenFilePicker; // force the <input type=file> fallback so Playwright can feed a file
});
const host = await hostCtx.newPage();
host.on('pageerror', (e) => console.log('[host pageerror]', e.message));
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();
check('room created', true, roomUrl);
await host.waitForSelector('text=Choose a video file');

const [chooser] = await Promise.all([host.waitForEvent('filechooser'), host.click('text=Choose a video file')]);
await chooser.setFiles(videoPath);
await host.waitForSelector('text=STREAMING', { timeout: 15000 });
check('host started streaming', true);

// ---- 3. viewer joins from another browser context
const viewerCtx = await browser.newContext();
const viewer = await viewerCtx.newPage();
viewer.on('pageerror', (e) => console.log('[viewer pageerror]', e.message));
const streamLogs = [];
viewer.on('console', (m) => {
  if (m.type() === 'error') console.log('[viewer console]', m.text());
  if (m.text().startsWith('[stream]')) streamLogs.push(m.text());
});
await viewer.goto(roomUrl);
await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
await viewer.click('button:has-text("Join")');

const state = () =>
  viewer.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    const b = v.buffered;
    return {
      cur: v.currentTime,
      start: b.length ? b.start(0) : null,
      end: b.length ? b.end(b.length - 1) : null,
      ready: v.readyState,
      paused: v.paused,
    };
  });

let s = null;
for (let i = 0; i < 40; i++) {
  s = await state();
  if (s && s.end !== null && s.end > 3) break;
  await sleep(500);
}
check('viewer receives and buffers video through the room server', !!s && s.end > 3, JSON.stringify(s));
if (!(s && s.end > 3)) {
  console.log('  viewer banner:', await viewer.locator('.overlay-msg').allTextContents());
  console.log('  viewer [stream] log:\n    ' + streamLogs.slice(0, 20).join('\n    '));
}
await sleep(2500);
const s2 = await state();
check('viewer is playing (currentTime advancing)', !!s2 && !!s && s2.cur > s.cur + 1, `${s?.cur} -> ${s2?.cur}`);
check('viewer follows the live edge (< 4s behind)', !!s2 && s2.end - s2.cur < 4, JSON.stringify(s2));
check('host viewer count shows 1 watching', await host.locator('text=1 watching').count() > 0);

// ---- 4. rewind allowed, forward blocked
const rewound = await viewer.evaluate(async () => {
  const v = document.querySelector('video');
  v.currentTime = 0.5;
  await new Promise((r) => setTimeout(r, 400));
  return v.currentTime;
});
check('viewer can rewind', rewound < 3, `currentTime=${rewound}`);
const forward = await viewer.evaluate(async () => {
  const v = document.querySelector('video');
  const edge = v.buffered.end(v.buffered.length - 1);
  v.currentTime = edge + 500;
  await new Promise((r) => setTimeout(r, 400));
  return { cur: v.currentTime, edge: v.buffered.end(v.buffered.length - 1) };
});
check('viewer cannot skip past live edge', forward.cur <= forward.edge + 0.5, JSON.stringify(forward));
check('"Go live" button appears when behind', await viewer.locator('button:has-text("Go live")').count() > 0 || forward.cur > forward.edge - 1.5);

// ---- 5. host disconnects, room survives, viewer keeps buffer; host resumes
const before = await state();
await host.close();
await viewer.waitForSelector('text=Host disconnected', { timeout: 8000 });
check('viewer sees host-away banner', true);
const away = await state();
check('viewer keeps its buffer while host is away', away.end >= before.end - 0.5 && away.start === before.start, JSON.stringify({ before, away }));

const host2 = await hostCtx.newPage();
await host2.goto(roomUrl);
await host2.waitForSelector('text=Resume stream', { timeout: 10000 });
check('returning host is offered Resume', true);
const [chooser2] = await Promise.all([host2.waitForEvent('filechooser'), host2.click('text=Resume stream')]);
await chooser2.setFiles(videoPath);
await host2.waitForSelector('text=STREAMING', { timeout: 15000 });

let after = null;
for (let i = 0; i < 40; i++) {
  after = await state();
  if (after && after.end > away.end + 2) break;
  await sleep(500);
}
check('stream continues after host resumes (buffer keeps growing)', !!after && after.end > away.end + 2, JSON.stringify({ away, after }));
if (!(after && after.end > away.end + 2)) {
  console.log('  viewer banner:', await viewer.locator('.overlay-msg').allTextContents());
  console.log('  viewer [stream] log (last 12 of ' + streamLogs.length + '):\n    ' + streamLogs.slice(-12).join('\n    '));
  const hv = () => host2.evaluate(() => { const v = document.querySelector('video'); return { cur: v.currentTime, paused: v.paused, ended: v.ended, ready: v.readyState, dur: v.duration, seekable: v.seekable.length ? [v.seekable.start(0), v.seekable.end(0)] : null }; });
  console.log('  host2 video  :', JSON.stringify(await hv()));
  await sleep(1500);
  console.log('  host2 video  :', JSON.stringify(await hv()));
  console.log('  host2 panel  :', (await host2.locator('.host-live').innerText().catch(() => 'n/a')).replace(/\n+/g, ' | '));
}

await browser.close();
console.log(failures === 0 ? '\nAll stream e2e checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
