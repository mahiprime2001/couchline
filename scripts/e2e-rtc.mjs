// Real-browser test of screen share over WebRTC: the host's picture goes straight to the viewer. Then the same
// with direct connections switched off on the viewer, which must fall back to the room server and still play.
// Needs the Node server running (it serves the built web app) and Chrome installed.
//   BASE=http://127.0.0.1:8794 node scripts/e2e-rtc.mjs
import { chromium } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8794';
const CHANNEL = process.env.CHANNEL ?? 'chrome';
const require = createRequire(fileURLToPath(new URL('../apps/server/package.json', import.meta.url)));
const ffmpeg = require('ffmpeg-static');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a short test video with sound, made with ffmpeg
const videoPath = join(mkdtempSync(join(tmpdir(), 'rtc-e2e-')), 'test.mp4');
const made = spawnSync(
  ffmpeg,
  ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=30:size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoPath],
  { timeout: 120_000 },
);
if (made.status !== 0) {
  console.error('could not make the test video');
  process.exit(1);
}

const browser = await chromium.launch({
  channel: CHANNEL,
  headless: true,
  // two tabs on one computer find each other by their local addresses only if these are not hidden behind mDNS names
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'],
});

/** the [rtc] console lines of both tabs, shown when a direct connection fails */
const rtcLogs = [];

/** One host sharing a file, and one viewer. `viewerInit` runs before the viewer's page loads. */
async function scenario(name, viewerInit) {
  console.log(`\n=== ${name}`);
  const hostCtx = await browser.newContext();
  await hostCtx.addInitScript(() => {
    delete window.showOpenFilePicker; // use the <input type=file> fallback so the test can feed a file
  });
  const host = await hostCtx.newPage();
  host.on('pageerror', (e) => console.log('   [host pageerror]', e.message));
  host.on('console', (m) => m.text().startsWith('[rtc]') && rtcLogs.push(`host:   ${m.text()}`));
  await host.goto(BASE);
  await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
  await host.click('text=Create a room');
  await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
  const roomUrl = host.url();
  await host.waitForSelector('text=Choose a video file');
  const [chooser] = await Promise.all([host.waitForEvent('filechooser'), host.click('text=Choose a video file')]);
  await chooser.setFiles(videoPath);
  await host.waitForSelector('text=STREAMING', { timeout: 20_000 });

  const viewerCtx = await browser.newContext();
  if (viewerInit) await viewerCtx.addInitScript(viewerInit);
  const viewer = await viewerCtx.newPage();
  viewer.on('pageerror', (e) => console.log('   [viewer pageerror]', e.message));
  viewer.on('console', (m) => m.text().startsWith('[rtc]') && rtcLogs.push(`viewer: ${m.text()}`));
  await viewer.goto(roomUrl);
  await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
  await viewer.click('button:has-text("Join")');
  return { host, viewer, hostCtx, viewerCtx };
}

const picture = (page) =>
  page.evaluate(() => {
    const v = document.querySelector('video');
    if (!v) return null;
    return {
      cur: +v.currentTime.toFixed(2),
      direct: v.srcObject instanceof MediaStream, // the WebRTC path plays a live stream object
      served: v.src.startsWith('blob:'), // the server path plays through MediaSource (a blob URL)
      ready: v.readyState,
    };
  });

// ---- 1. the picture goes directly to the viewer
{
  const { host, viewer, hostCtx, viewerCtx } = await scenario('direct (WebRTC)');
  let p = null;
  for (let i = 0; i < 60; i++) {
    p = await picture(viewer);
    if (p?.direct && p.ready >= 2) break;
    await sleep(500);
  }
  check('viewer gets the picture as a live WebRTC stream', !!p?.direct, JSON.stringify(p));
  if (!p?.direct) console.log('  [rtc] steps:\n    ' + rtcLogs.join('\n    '));
  check('the room server path is not used for this viewer', !!p && !p.served, JSON.stringify(p));
  const a = await picture(viewer);
  await sleep(3000);
  const b = await picture(viewer);
  check('viewer is playing (picture moving)', !!a && !!b && b.cur > a.cur + 1, `${a?.cur} -> ${b?.cur}`);
  const banner = await viewer.locator('.overlay-msg').allTextContents();
  check('no "connecting" message left on the viewer', !banner.some((t) => /Connecting/.test(t)), JSON.stringify(banner));
  check('the host counts the direct viewer as watching', (await host.locator('text=1 watching').count()) > 0);
  await hostCtx.close();
  await viewerCtx.close();
}

// ---- 2. direct connections switched off on the viewer: the server path takes over and plays
{
  const { viewer, hostCtx, viewerCtx } = await scenario('fallback (no direct connection on the viewer)', () => {
    delete window.RTCPeerConnection;
  });
  let p = null;
  for (let i = 0; i < 80; i++) {
    p = await picture(viewer);
    if (p?.served && p.ready >= 2) break;
    await sleep(500);
  }
  check('viewer falls back to the room server and gets the picture', !!p?.served, JSON.stringify(p));
  const a = await picture(viewer);
  await sleep(3000);
  const b = await picture(viewer);
  check('fallback viewer is playing (picture moving)', !!a && !!b && b.cur > a.cur + 1, `${a?.cur} -> ${b?.cur}`);
  await hostCtx.close();
  await viewerCtx.close();
}

// ---- 3. three viewers: the host serves two directly, the third gets the picture passed on by one of them
{
  console.log('\n=== relay (three viewers)');
  const hostCtx = await browser.newContext();
  await hostCtx.addInitScript(() => {
    delete window.showOpenFilePicker;
  });
  const host = await hostCtx.newPage();
  host.on('pageerror', (e) => console.log('   [host pageerror]', e.message));
  await host.goto(BASE);
  await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
  await host.click('text=Create a room');
  await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
  const roomUrl = host.url();
  await host.waitForSelector('text=Choose a video file');
  const [chooser] = await Promise.all([host.waitForEvent('filechooser'), host.click('text=Choose a video file')]);
  await chooser.setFiles(videoPath);
  await host.waitForSelector('text=STREAMING', { timeout: 20_000 });

  const viewers = [];
  for (const name of ['ViewerA', 'ViewerB', 'ViewerC']) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`   [${name} pageerror]`, e.message));
    await page.goto(roomUrl);
    await page.fill('input[placeholder="Your nickname"]', name);
    await page.click('button:has-text("Join")');
    viewers.push({ ctx, page });
    await sleep(2500); // let each one settle before the next joins
  }

  const pictures = [];
  for (let i = 0; i < 80; i++) {
    pictures.length = 0;
    for (const { page } of viewers) pictures.push(await picture(page));
    if (pictures.every((p) => p?.direct && p.ready >= 2)) break;
    await sleep(500);
  }
  check('the first two viewers get the picture from the host', pictures.slice(0, 2).every((p) => p?.direct), JSON.stringify(pictures));
  check('the third viewer gets the picture passed on by another viewer', pictures[2]?.direct === true, JSON.stringify(pictures[2]));
  const a = await picture(viewers[2].page);
  await sleep(3000);
  const b = await picture(viewers[2].page);
  check('the third viewer is playing (picture moving)', !!a && !!b && b.cur > a.cur + 1, `${a?.cur} -> ${b?.cur}`);
  for (const { ctx } of viewers) await ctx.close();
  await hostCtx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll WebRTC checks passed');
process.exit(failures ? 1 : 0);
