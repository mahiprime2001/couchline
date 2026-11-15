// Real-browser test of "Download & host link": the host pastes a link, the server downloads it with yt-dlp,
// converts it, and a viewer plays the hosted copy. Needs the Node backend with yt-dlp + ffmpeg installed,
// run on the same computer (yt-dlp is local-only). Downloads a 19-second public YouTube video.
//   BASE=http://localhost:5173 node scripts/e2e-ytdlp.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const LINK = process.env.LINK ?? 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const host = await (await browser.newContext()).newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();

const viewer = await (await browser.newContext()).newPage();
await viewer.goto(roomUrl);
await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('.side', { timeout: 10000 });

const btn = host.locator('button:has-text("Download & host link")');
await btn.waitFor({ timeout: 10000 });
check('host sees "Download & host link"', true);
check('it is disabled until a link is pasted', await btn.isDisabled());
check('viewer does not see it', (await viewer.locator('button:has-text("Download & host link")').count()) === 0);

await host.fill('input[aria-label="Video link"]', LINK);
await btn.click();
check('link box clears once the server takes the link', await (async () => {
  for (let i = 0; i < 20; i++) {
    if ((await host.inputValue('input[aria-label="Video link"]')) === '') return true;
    await sleep(250);
  }
  return false;
})());

// download + convert, then the room switches to the hosted copy for everyone
let status = '';
let playing = false;
for (let i = 0; i < 240 && !playing; i++) {
  await sleep(1000);
  status = await host.locator('.hosted-status').innerText().catch(() => '');
  if (/⚠️/.test(status)) break;
  playing = await viewer.evaluate(() => {
    const v = document.querySelector('.video-area video');
    return !!v && v.currentTime > 1 && !v.paused;
  });
}
check('viewer plays the downloaded video', playing, status);
check('status shows the title yt-dlp found, not the raw link', status !== '' && !status.includes(LINK), status);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll yt-dlp e2e checks passed.');
process.exit(failures ? 1 : 0);
