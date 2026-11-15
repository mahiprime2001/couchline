// Real-browser test of the Queue tab's YouTube features: search, playlists ("Add all"), "Suggested next",
// the Played history with Previous / play again, autoplay of similar videos, and the duration bar.
// Needs the Node backend with yt-dlp (lists only: nothing is downloaded, auto yt-dlp is switched off here).
//   BASE=http://localhost:5173 node scripts/e2e-queue.mjs
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(400);
  }
  return false;
};

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
// deterministic queue: no yt-dlp downloads, and autoplay only where this test turns it on
await ctx.addInitScript(() => {
  localStorage.setItem('wp-ytdlp-auto', '0');
  localStorage.setItem('wp-autoplay', '0');
});
const host = await ctx.newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
await host.click('.tabs button:has-text("Queue")');

const box = host.locator('input[aria-label="Search YouTube or paste a link"]');
const upNext = () => host.locator('h4:has-text("Up next") + ul.queue > li').count();
const sub = (name) => host.click(`.subtabs button:has-text("${name}")`);

// ---- search
await box.fill('me at the zoo');
await host.click('.queue-panel button:has-text("Search")');
check('search shows YouTube results', await waitFor(async () => (await host.locator('.yt-results .yt-list li').count()) >= 5));
const firstTitle = await host.locator('.yt-results .yt-list li .yt-meta b').first().innerText();
check('results have titles and thumbnails', firstTitle.length > 0 && (await host.locator('.yt-results .yt-list li img.qthumb').count()) >= 5, firstTitle);

// play #1, then #2: #1 goes to Played
const rows = host.locator('.yt-results .yt-list li');
const t1 = await rows.nth(0).locator('.yt-meta b').innerText();
await rows.nth(0).locator('button[aria-label^="Play "]').click();
await sub('Playing now');
check('playing a result shows it under Now playing', await waitFor(async () => (await host.locator('.now-playing').innerText()).includes(t1.slice(0, 20))), t1);
await sub('Suggestions');
const t2 = await rows.nth(1).locator('.yt-meta b').innerText();
await rows.nth(1).locator('button[aria-label^="Play "]').click();
await sub('Playing now');
check('the previous video moves to Played', await waitFor(async () => (await host.locator('ul.queue.played').innerText()).includes(t1.slice(0, 20))));

// add #3 and #4 to Up next
await sub('Suggestions');
await rows.nth(2).locator('button:has-text("Add")').click();
await rows.nth(3).locator('button:has-text("Add")').click();
await sub('Playing now');
check('"+ Add" puts results in Up next, with titles', await waitFor(async () => (await upNext()) === 2));

// ---- Previous: back to #1, and #2 returns to the top of Up next
await host.click('.queue-tools button:has-text("Previous")');
check('Previous plays the last played video again', await waitFor(async () => (await host.locator('.now-playing').innerText()).includes(t1.slice(0, 20))));
check('...and what was playing goes back to the top of Up next', await waitFor(async () => (await host.locator('h4:has-text("Up next") + ul.queue > li').first().innerText()).includes(t2.slice(0, 20))));

// ---- suggestions for the playing video
await sub('Suggestions');
check('"Suggested next" lists videos like the one playing', await waitFor(async () => (await host.locator('.yt-suggested .yt-list li').count()) >= 3, 90000));

// ---- a playlist link shows every song, and "Add all" queues them
await box.fill(process.env.PLAYLIST ?? 'https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI');
await host.click('.queue-panel form button[type="submit"]');
check('a playlist link lists all its songs', await waitFor(async () => (await host.locator('.yt-results .yt-list li').count()) >= 10, 90000));
await sub('Playing now');
const before = await upNext();
await sub('Suggestions');
await host.click('.yt-results button:has-text("Add all")');
await sub('Playing now');
check('"Add all" queues the whole playlist in one go', await waitFor(async () => (await upNext()) >= before + 8), `${before} -> ${await upNext()}`);

// ---- duration bar: a drag released off the bar still seeks, and the bar keeps following playback
const bar = host.locator('.controls .seek');
const bb = await bar.boundingBox();
if (bb) {
  await host.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height / 2);
  await host.mouse.down();
  await host.mouse.move(bb.x + bb.width * 0.5, bb.y + bb.height / 2);
  await host.mouse.move(bb.x + bb.width * 0.5, bb.y - 120); // let go well above the bar
  await host.mouse.up();
  await sleep(1500);
  const a = Number(await bar.inputValue());
  await sleep(2500);
  const b = Number(await bar.inputValue());
  check('a drag let go off the bar does not freeze it', b !== a || (await host.locator('.controls button[aria-label="Play"]').count()) > 0, `${a} -> ${b}`);
}
await bar.hover();
check('hovering the bar shows the time under the pointer', (await host.locator('.seek-tip').count()) === 1);

// ---- autoplay: clear Up next, switch it on, and a similar video gets queued
await host.click('h4:has-text("Up next") button:has-text("Clear")');
check('Clear empties Up next', await waitFor(async () => (await upNext()) === 0, 10000));
await host.check('label:has-text("Autoplay similar videos") input');
check('autoplay queues a similar video when Up next is empty', await waitFor(async () => (await upNext()) === 1, 90000));
// removing what autoplay added must not bring it (or another) straight back for the same song
await host.locator('h4:has-text("Up next") + ul.queue > li button[aria-label="Remove"]').click();
await sleep(6000);
check('a removed autoplay pick stays removed', (await upNext()) === 0, `${await upNext()} in Up next`);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll queue e2e checks passed.');
process.exit(failures ? 1 : 0);
