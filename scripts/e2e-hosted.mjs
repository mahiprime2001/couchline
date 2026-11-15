// Real-browser test of "YouTube-style" hosting: the host uploads a file, the server converts it to HLS
// chunks, a viewer plays it with sound and can rewind but not skip ahead.
//   node scripts/e2e-hosted.mjs <video-file> [<video-file> ...]     (needs the Node backend + Vite running)
import { chromium } from 'playwright-core';
import { basename } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/e2e-hosted.mjs <video-file> [...]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + x}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const vp = { width: 1366, height: 768 };
const page = async () => (await browser.newContext({ viewport: vp })).newPage();

// peak loudness of what the <video> is actually outputting, over a few seconds
const loudness = (p, secs = 3) =>
  p.evaluate(async (secs) => {
    const el = document.querySelector('video');
    const ac = new AudioContext();
    await ac.resume();
    const an = ac.createAnalyser();
    an.fftSize = 2048;
    const src = ac.createMediaElementSource(el);
    src.connect(an);
    an.connect(ac.destination);
    const buf = new Float32Array(an.fftSize);
    let peak = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      an.getFloatTimeDomainData(buf);
      for (const x of buf) peak = Math.max(peak, Math.abs(x));
      await new Promise((r) => setTimeout(r, 50));
    }
    return +peak.toFixed(3);
  }, secs);

const state = (p) =>
  p.evaluate(() => {
    const v = document.querySelector('video');
    return { cur: +v.currentTime.toFixed(1), paused: v.paused, dur: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : null };
  });

for (const file of files) {
  const label = basename(file);
  console.log(`\n=== ${label}`);
  const host = await page();
  host.on('pageerror', (e) => console.log('   [host pageerror]', e.message));
  await host.goto(BASE);
  await host.fill('input[placeholder="e.g. Alex"]', 'UploadHost');
  await host.click('text=Create a room');
  await host.waitForURL(/\/r\//);
  const room = host.url();

  const upBtn = host.locator('button:has-text("Upload a file")');
  await upBtn.waitFor();
  await sleep(800);
  check('the "Upload a file" button is available', await upBtn.isEnabled(), 'disabled: is the Node backend (with ffmpeg) running?');

  await host.locator('input[type=file][accept*="video"]').setInputFiles(file);
  let playing = true;
  try {
    await host.waitForSelector('.hosted-status:has-text("Playing")', { timeout: 60000 });
  } catch {
    playing = false;
  }
  const statusText = await host.locator('.hosted-status').allTextContents();
  check('upload -> conversion -> playing for everyone', playing, JSON.stringify(statusText));
  if (!playing) {
    await host.context().close();
    continue;
  }

  const viewer = await page();
  viewer.on('pageerror', (e) => console.log('   [viewer pageerror]', e.message));
  await viewer.goto(room);
  await viewer.fill('input[placeholder="Your nickname"]', 'Watcher');
  await viewer.click('button:has-text("Join")');
  await viewer.waitForSelector('video', { timeout: 15000 });
  await sleep(6000);

  const v1 = await state(viewer);
  check('viewer is playing the hosted video', !v1.paused && v1.cur > 0.5, JSON.stringify(v1));
  const peak = await loudness(viewer, 3);
  check('viewer actually hears sound (peak level above silence)', peak > 0.01, `peak=${peak}`);

  const h1 = await state(host);
  check('host and viewer are in sync', Math.abs(h1.cur - (await state(viewer)).cur) < 3, JSON.stringify({ h1, v: await state(viewer) }));

  // rewind with the real slider, never ahead of the host
  const seek = await viewer.locator('.seek').boundingBox();
  await viewer.mouse.click(seek.x + seek.width * 0.1, seek.y + seek.height / 2);
  await sleep(1500);
  const rewound = await state(viewer);
  const hostNow = await state(host);
  check('viewer can rewind by clicking the seek bar', rewound.cur < hostNow.cur - 1.5 || hostNow.cur < 3, JSON.stringify({ rewound, hostNow }));
  await viewer.evaluate((x) => { document.querySelector('video').currentTime = x; }, hostNow.cur + 30);
  await sleep(1500);
  const ahead = await state(viewer);
  check('viewer cannot skip ahead of the host', ahead.cur <= (await state(host)).cur + 1.5, JSON.stringify({ ahead, host: await state(host) }));

  await host.context().close();
  await viewer.context().close();
}

await browser.close();
console.log(failures === 0 ? '\nAll hosted-video checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
