// Real-browser test of music mode: YouTube songs are fetched as sound only, everyone sees the cover screen,
// and the next song in Up next is fetched ahead so it starts without a wait.
// Needs the Node backend with yt-dlp + ffmpeg. Downloads the audio of two short public YouTube videos.
//   BASE=http://localhost:5173 node scripts/e2e-music.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 90000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(300);
  }
  return false;
};

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const hostCtx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
await hostCtx.addInitScript(() => {
  localStorage.setItem('wp-ytdlp-auto', '1');
  localStorage.setItem('wp-music', '1');
  localStorage.setItem('wp-autoplay', '0');
});
const host = await hostCtx.newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);

const viewer = await (await browser.newContext()).newPage();
await viewer.goto(host.url());
await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('.side', { timeout: 10000 });

check('the host has the Music mode switch, on', await host.isChecked('label:has-text("Music mode") input'));

// play the first search result, queue the second
await host.click('.tabs button:has-text("Queue")');
await host.fill('input[aria-label="Search YouTube or paste a link"]', 'me at the zoo');
await host.click('.queue-panel button:has-text("Search")');
await host.waitForSelector('.yt-results .yt-list li', { timeout: 60000 });
const rows = host.locator('.yt-results .yt-list li');
// song 1 is the longer result (it must still be playing when the test presses Next), song 2 the short one
const t1 = await rows.nth(1).locator('.yt-meta b').innerText();
const t2 = await rows.nth(0).locator('.yt-meta b').innerText();
await rows.nth(1).locator('button[aria-label^="Play "]').click();
await rows.nth(0).locator('button:has-text("Add")').click();

const started = Date.now();
const npTitle = () => viewer.locator('.np-art b').innerText();
check('the viewer sees the now-playing screen for song 1', await waitFor(async () => (await npTitle()).includes(t1.slice(0, 15))), t1);
console.log(`      (song 1 ready for the viewer after ${((Date.now() - started) / 1000).toFixed(1)} s)`);
check('...with its cover art', (await viewer.locator('.np-art .np-cover img').count()) === 1);
check('...and it is sound only (no picture)', await viewer.evaluate(() => document.querySelector('.video-area video').videoWidth === 0));
check('...and it is actually playing', await waitFor(async () => viewer.evaluate(() => { const v = document.querySelector('.video-area video'); return v.currentTime > 1 && !v.paused; }), 20000));
check('the screen names the next song', (await viewer.locator('.np-next').innerText().catch(() => '')).includes(t2.slice(0, 15)));

// give the host page time to fetch song 2 ahead, then skip to it
await sleep(12000);
await host.click('.subtabs button:has-text("Playing now")');
await host.click('.queue-tools button:has-text("Next")');
const skipped = Date.now();
check('after Next, song 2 is on everyone’s screen', await waitFor(async () => (await npTitle()).includes(t2.slice(0, 15)), 30000), t2);
const wait2 = (Date.now() - skipped) / 1000;
console.log(`      (song 2 ready ${wait2.toFixed(1)} s after Next)`);
check('the preloaded song starts within 6 seconds', wait2 < 6, `${wait2.toFixed(1)} s`);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll music mode e2e checks passed.');
process.exit(failures ? 1 : 0);
