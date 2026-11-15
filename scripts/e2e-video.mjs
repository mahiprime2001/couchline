// Real-browser test of video chat: two people join voice, turn cameras on and off, and see each other's tiles.
// Uses Chrome's fake camera and microphone, so no real hardware is needed.
// Needs `pnpm dev` running and Chrome or Edge installed.   node scripts/e2e-video.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? 'chrome',
  headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const origin = new URL(BASE).origin;

const hostCtx = await browser.newContext();
await hostCtx.grantPermissions(['camera', 'microphone'], { origin });
const host = await hostCtx.newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();

const viewerCtx = await browser.newContext();
await viewerCtx.grantPermissions(['camera', 'microphone'], { origin });
const viewer = await viewerCtx.newPage();
await viewer.goto(roomUrl);
await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('.call-grid, .side', { timeout: 10000 });

// tile for a named person: .call-tile is "live" when that person's camera is sending frames
const tile = (page, name) => page.locator('.call-tile', { has: page.locator('.call-name', { hasText: name }) });
const isLive = async (page, name) => {
  const t = tile(page, name);
  if ((await t.count()) === 0) return false;
  return t.first().evaluate((el) => el.classList.contains('live'));
};
const waitFor = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(300);
  }
  return false;
};

await host.click('button:has-text("Join voice")');
await host.waitForSelector('button:has-text("Camera off")', { timeout: 10000 });
await viewer.click('button:has-text("Join voice")');
await viewer.waitForSelector('button:has-text("Camera off")', { timeout: 10000 });
check('both joined voice', true);

// camera is off by default: the host's tile shows an initial, not a live picture
check('camera is off by default', !(await isLive(viewer, 'HostUser')));

await host.click('button:has-text("Camera off")');
check('host camera button switches to "Camera on"', await waitFor(async () => (await host.locator('button:has-text("Camera on")').count()) === 1));
check('viewer sees the host camera turn on', await waitFor(() => isLive(viewer, 'HostUser')));
const frames = await waitFor(async () => {
  const v = tile(viewer, 'HostUser').locator('video');
  return (await v.count()) > 0 && (await v.evaluate((el) => el.videoWidth)) > 0;
});
check('viewer receives real video frames from the host', frames);

await viewer.click('button:has-text("Camera off")');
check('host sees the viewer camera turn on', await waitFor(() => isLive(host, 'ViewerUser')));

await host.click('button:has-text("Camera on")');
check('viewer sees the host camera turn off', await waitFor(async () => !(await isLive(viewer, 'HostUser'))));

// a person leaving voice takes their tile away
await host.click('button:has-text("Leave voice")');
check('host leaving voice removes their tile for the viewer', await waitFor(async () => (await tile(viewer, 'HostUser').count()) === 0));

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll video chat e2e checks passed.');
process.exit(failures ? 1 : 0);
