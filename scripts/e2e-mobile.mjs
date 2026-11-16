// Phone check: layout, touch, landscape, and phones that lack screen share / MediaSource.
// Uses Chrome's Pixel 7 emulation (real touch events + phone viewport + mobile identity).
// Emulation checks the UI and flows; it is NOT a real phone engine (iPhone Safari differs).
//   node scripts/e2e-mobile.mjs        needs `pnpm dev` running and Chrome or Edge installed
import { chromium, devices } from 'playwright-core';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestVideo } from './testvideo.mjs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const OUT = process.env.SCREENSHOTS ?? tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + x}`);
  if (!ok) fails++;
};

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});
const clip = await makeTestVideo(browser, 30);
const size = statSync(clip).size;
const server = createServer((req, res) => {
  const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  const h = { 'content-type': 'video/webm', 'accept-ranges': 'bytes' };
  if (m) {
    const s = +m[1], e = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { ...h, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
    createReadStream(clip, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { ...h, 'content-length': size });
    createReadStream(clip).pipe(res);
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/clip.webm`;
const phone = devices['Pixel 7'];

const metrics = (p) =>
  p.evaluate(() => {
    const small = [];
    for (const el of document.querySelectorAll('button, input:not([type=hidden]), select, a')) {
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      if (b.height < 30 || b.width < 30) {
        const name = el.getAttribute('aria-label') || el.title || el.textContent || el.placeholder || el.tagName;
        small.push(`${name.trim().slice(0, 18)} ${Math.round(b.width)}x${Math.round(b.height)}`);
      }
    }
    const ctl = document.querySelector('.controls-row')?.getBoundingClientRect();
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    return {
      vw: innerWidth,
      vh: innerHeight,
      overflowX: document.documentElement.scrollWidth - innerWidth,
      controlsInsideStage: ctl && stage ? ctl.bottom <= stage.bottom + 1 && ctl.right <= stage.right + 1 : null,
      controlsRight: ctl ? Math.round(ctl.right) : null,
      small: small.slice(0, 8),
    };
  });

// ---- 1. a phone creates a room and plays a link
const host = await (await browser.newContext({ ...phone })).newPage();
await host.goto(BASE);
await host.screenshot({ path: join(OUT, 'm-landing.png') });
const land = await metrics(host);
check('landing: no sideways scrolling on a phone', land.overflowX <= 1, JSON.stringify(land));
await host.fill('input[placeholder="e.g. Alex"]', 'PhoneHost');
await host.tap('text=Create a room');
await host.waitForURL(/\/r\//);
const room = host.url();
await host.fill('input[placeholder^="Paste a YouTube"]', url);
await host.tap('text=Play for everyone');
await host.waitForSelector('video', { timeout: 10000 });
await sleep(2500);
await host.screenshot({ path: join(OUT, 'm-room-host.png') });
const rm = await metrics(host);
check('room: no sideways scrolling', rm.overflowX <= 1, JSON.stringify(rm));
check('room: control row inside the player and inside the screen width', rm.controlsInsideStage === true && rm.controlsRight <= rm.vw, JSON.stringify(rm));
console.log('   small tap targets (<30px):', JSON.stringify(rm.small));

// ---- 2. a phone viewer: finger rewind, play/pause, chat
const viewer = await (await browser.newContext({ ...phone })).newPage();
await viewer.goto(room);
await viewer.fill('input[placeholder="Your nickname"]', 'PhoneViewer');
await viewer.tap('button:has-text("Join")');
await viewer.waitForSelector('video', { timeout: 10000 });
await sleep(7000);
const st = () => viewer.evaluate(() => { const v = document.querySelector('video'); return { cur: +v.currentTime.toFixed(1), paused: v.paused }; });
const hostT = () => host.evaluate(() => +document.querySelector('video').currentTime.toFixed(1));
check('phone viewer is playing in sync with the host', !(await st()).paused && Math.abs((await st()).cur - (await hostT())) < 3);
const seek = await viewer.locator('.seek').boundingBox();
const beforeTap = await st();
await viewer.touchscreen.tap(seek.x + seek.width * 0.15, seek.y + seek.height / 2);
await sleep(1500);
const afterTap = await st();
// in a room of 2 the phone viewer controls playback, so the host rewinds too: compare with where the phone was
check('tapping the seek bar with a finger rewinds', afterTap.cur < beforeTap.cur - 3, JSON.stringify({ beforeTap, afterTap }));
await viewer.tap('.controls button[aria-label="Pause"]');
await sleep(600);
check('tapping Pause pauses', (await st()).paused);
await viewer.screenshot({ path: join(OUT, 'm-room-viewer.png') });
await viewer.tap('.tabs button:has-text("Chat")');
await viewer.fill('.chat-form input', 'hello from a phone');
await viewer.tap('.chat-form button[type="submit"]');
check('chat from a phone reaches the host', await host.locator('.msg:has-text("hello from a phone")').first().waitFor({ timeout: 4000 }).then(() => true, () => false));

// ---- 3. landscape
await viewer.setViewportSize({ width: phone.viewport.height, height: phone.viewport.width });
await sleep(800);
const ls = await metrics(viewer);
check('landscape: control row still inside the player', ls.controlsInsideStage === true, JSON.stringify(ls));
await viewer.screenshot({ path: join(OUT, 'm-landscape.png') });

// ---- 4. phones that lack screen share (Android Chrome, iPhone Safari)
const lctx = await browser.newContext({ ...phone });
await lctx.addInitScript(() => {
  try { delete MediaDevices.prototype.getDisplayMedia; } catch { /* ignore */ }
  try { Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: undefined, configurable: true }); } catch { /* ignore */ }
  delete window.showOpenFilePicker;
});
const lh = await lctx.newPage();
lh.on('pageerror', (e) => console.log('   [pageerror on limited phone host]', e.message));
await lh.goto(BASE);
await lh.fill('input[placeholder="e.g. Alex"]', 'LimitedHost');
await lh.tap('text=Create a room');
await lh.waitForURL(/\/r\//);
await lh.waitForSelector('text=Stream from your computer');
check('phone without screen share: the start-panel button is gone', (await lh.locator('button:has-text("Share a screen")').count()) === 0, 'button still shown; tapping it would fail');
const barBtn = lh.locator('button:has-text("Share screen / tab")');
check('...and the room-bar button is visible but disabled, with a reason', (await barBtn.count()) === 1 && (await barBtn.isDisabled()) && ((await barBtn.getAttribute('title')) ?? '').includes('Not available'));
await lh.screenshot({ path: join(OUT, 'm-limited-host.png') });

// ---- 5. an iPhone-like viewer (no MediaSource) watching a desktop host's stream
const dctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
await dctx.addInitScript(() => { delete window.showOpenFilePicker; });
const dhost = await dctx.newPage();
await dhost.goto(BASE);
await dhost.fill('input[placeholder="e.g. Alex"]', 'DeskHost');
await dhost.click('text=Create a room');
await dhost.waitForURL(/\/r\//);
const room2 = dhost.url();
const [fc] = await Promise.all([dhost.waitForEvent('filechooser'), dhost.locator('button:has-text("Stream a file"), button:has-text("Choose a video file")').first().click()]);
await fc.setFiles(clip);
await dhost.waitForSelector('text=STREAMING', { timeout: 15000 });
const ictx = await browser.newContext({ ...phone });
await ictx.addInitScript(() => { delete window.MediaSource; delete window.ManagedMediaSource; });
const iv = await ictx.newPage();
iv.on('pageerror', (e) => console.log('   [pageerror on iPhone-like viewer]', e.message));
await iv.goto(room2);
await iv.fill('input[placeholder="Your nickname"]', 'iPhoneLike');
await iv.tap('button:has-text("Join")');
await sleep(4000);
const banner = (await iv.locator('.overlay-msg').allTextContents()).join(' ');
check('viewer without MediaSource gets a clear message, not a crash', banner.toLowerCase().includes('cannot play'), JSON.stringify(banner));
check('...and can still use the chat in that room', (await iv.locator('.chat-form input').count()) > 0);
await iv.screenshot({ path: join(OUT, 'm-iphone-like-viewer.png') });

// ---- 6. a desktop host with a link already playing can still find and use "Share screen / tab"
await dhost.fill('input[placeholder^="Paste a YouTube"]', url).catch(() => undefined);
const dctx2 = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const d2 = await dctx2.newPage();
await d2.goto(BASE);
await d2.fill('input[placeholder="e.g. Alex"]', 'DeskLink');
await d2.click('text=Create a room');
await d2.waitForURL(/\/r\//);
await d2.fill('input[placeholder^="Paste a YouTube"]', url);
await d2.click('text=Play for everyone');
await d2.waitForSelector('video', { timeout: 10000 });
const screenBtn = d2.locator('button:has-text("Share screen / tab")');
check('desktop host, link playing: "Share screen / tab" is visible and enabled', (await screenBtn.count()) === 1 && (await screenBtn.isEnabled()));

await browser.close();
server.close();
console.log(fails ? `\n${fails} check(s) failed. Screenshots in ${OUT}` : `\nAll mobile checks passed. Screenshots in ${OUT}`);
process.exit(fails ? 1 : 0);
