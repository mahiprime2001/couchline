// Real-browser test of auto yt-dlp: a viewer suggests a YouTube link, the host plays it from the Queue tab,
// and instead of the YouTube embed the room switches to a copy the server fetched with yt-dlp.
// Needs the Node backend with yt-dlp + ffmpeg. Downloads a 19-second public YouTube video.
//   BASE=http://localhost:5173 node scripts/e2e-ytdlp-auto.mjs
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

const viewer = await (await browser.newContext()).newPage();
await viewer.goto(host.url());
await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('.side', { timeout: 10000 });

// In a room of 3 or fewer, everyone controls playback and adds straight to Up next. Two more people make it 4, so
// the viewer's link is a suggestion the host has to play.
for (const nick of ['Extra1', 'Extra2']) {
  const extra = await (await browser.newContext()).newPage();
  await extra.goto(host.url());
  await extra.fill('input[placeholder="Your nickname"]', nick);
  await extra.click('button:has-text("Join")');
  await extra.waitForSelector('.room', { timeout: 10000 });
}

await host.waitForSelector('text=Auto yt-dlp for YouTube', { timeout: 10000 });
check('auto yt-dlp is on by default for the host', await host.isChecked('label:has-text("Auto yt-dlp") input'));
check('viewers do not get the toggle', (await viewer.locator('text=Auto yt-dlp for YouTube').count()) === 0);

// the viewer suggests, the host plays the suggestion
await viewer.click('.tabs button:has-text("Queue")');
await viewer.fill('.panel input', LINK);
await viewer.click('.panel button:has-text("Suggest")');
await host.click('.tabs button:has-text("Queue")');
await host.click('.subtabs button:has-text("Suggestions")');
const clicked = Date.now();
await host.locator('.panel button[aria-label="Play now"]').waitFor({ timeout: 10000 });
await host.click('.panel button[aria-label="Play now"]');

let status = '';
for (let i = 0; i < 180; i++) {
  await sleep(1000);
  status = await host.locator('.hosted-status').innerText().catch(() => '');
  if (/⚠️|Playing/.test(status)) break;
}
check('the host sees it fetched and playing for everyone', /Playing/.test(status), status);

let state = null;
for (let i = 0; i < 20; i++) {
  await sleep(500);
  state = await viewer.evaluate(() => {
    const v = document.querySelector('.video-area video');
    return v ? { cur: v.currentTime, paused: v.paused } : null;
  });
  if (state && state.cur > 1 && !state.paused) break;
}
check('the viewer plays the hosted copy, not the YouTube embed', !!state && state.cur > 1 && !state.paused && (await viewer.locator('.yt-holder').count()) === 0, JSON.stringify(state));

// the copy takes over where the room already was, instead of starting again from 0:00
const elapsed = (Date.now() - clicked) / 1000;
check('the copy picks up near where the room was (no restart from 0:00)', !!state && state.cur > Math.min(elapsed, 19) - 6, `at ${state?.cur?.toFixed(1)} s, ${elapsed.toFixed(1)} s after Play`);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll auto yt-dlp e2e checks passed.');
process.exit(failures ? 1 : 0);
