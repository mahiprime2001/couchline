// Real-browser checks of the phone UI: Up next fits the screen, the on-video play/pause and ±5 s buttons,
// the camera choice being remembered (one permission prompt when rejoining voice), and the unread chat badge.
// Needs `pnpm dev` running and Chrome or Edge installed.   BASE=http://localhost:5173 node scripts/e2e-ui.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { makeTestVideo } from './testvideo.mjs';

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
  args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

// a local 60 s test clip, served with Range support so it can seek
const file = await makeTestVideo(browser, 60);
const size = statSync(file).size;
const server = createServer((req, res) => {
  const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  const headers = { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'access-control-allow-origin': '*' };
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : size - 1;
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { ...headers, 'content-length': size });
    createReadStream(file).pipe(res);
  }
}).listen(0);
const clip = (n) => `http://localhost:${server.address().port}/clip${n}.webm`;

const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
await ctx.grantPermissions(['camera', 'microphone'], { origin: new URL(BASE).origin });
await ctx.addInitScript(() => localStorage.setItem('wp-autoplay', '0'));
const p = await ctx.newPage();
await p.goto(BASE);
await p.fill('input[placeholder="e.g. Alex"]', 'PhoneHost');
await p.tap('text=Create a room');
await p.waitForURL(/\/r\/[A-Z0-9]{6}/);

// play one clip, queue five more
await p.fill('input[aria-label="Video link"]', clip(0));
await p.tap('button:has-text("Play for everyone")');
await p.waitForSelector('.video-area video', { timeout: 15000 });
await p.tap('.tabs button:has-text("Queue")');
for (let i = 1; i <= 5; i++) {
  await p.fill('input[aria-label="Search YouTube or paste a link"]', clip(i));
  await p.locator('.queue-panel form button[type="submit"]').tap();
}
await sleep(1200);
const overflow = await p.evaluate(() =>
  [...document.querySelectorAll('.queue-panel li, .queue-panel .now-playing')].filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1).length,
);
check('Up next has 5 items', (await p.locator('h4:has-text("Up next") + ul.queue > li').count()) === 5);
check('every queue row fits inside the phone screen', overflow === 0, `${overflow} rows overflow`);
check('the page itself does not scroll sideways', await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

// someone chats while this phone is on the Queue tab: the Chat tab shows it
const friend = await (await browser.newContext()).newPage();
await friend.goto(p.url());
await friend.fill('input[placeholder="Your nickname"]', 'Friend');
await friend.click('button:has-text("Join")');
await friend.waitForSelector('.chat-form input', { timeout: 10000 });
await friend.fill('.chat-form input', 'hello from the other side');
await friend.press('.chat-form input', 'Enter');
check('the Chat tab shows an unread count', await p.locator('.tabs button:has-text("Chat") .unread').waitFor({ timeout: 8000 }).then(async () => (await p.locator('.tabs .unread').innerText()).trim() === '1', () => false));
check('a pop-up shows who said what', (await p.locator('.chat-toast').innerText().catch(() => '')).includes('hello from the other side'));
await p.tap('.tabs button:has-text("Chat")');
check('opening Chat clears the count', (await p.locator('.tabs .unread').count()) === 0);
await p.tap('.tabs button:has-text("Queue")');

// on-video buttons: hidden, a tap shows them, then they work
const t = () => p.evaluate(() => document.querySelector('.video-area video').currentTime);
await p.waitForFunction(() => document.querySelector('.video-area video')?.currentTime > 2, null, { timeout: 15000 });
check('the on-video buttons start hidden', !(await p.locator('.tap-controls.shown').count()));
await p.locator('.video-area .shield').tap();
check('a tap on the video shows play/pause and ±5 s', (await p.locator('.tap-controls.shown').count()) === 1);
const before = await t();
await p.locator('.tap-btn[aria-label="Forward 5 seconds"]').tap();
await sleep(600);
const fwd = await t();
check('⟳5 jumps forward about 5 seconds', fwd - before > 4 && fwd - before < 7.5, `${before.toFixed(1)} -> ${fwd.toFixed(1)}`);
await p.locator('.tap-btn[aria-label="Back 5 seconds"]').tap();
await sleep(600);
const back = await t();
check('⟲5 jumps back about 5 seconds', fwd - back > 3.5 && fwd - back < 6.5, `${fwd.toFixed(1)} -> ${back.toFixed(1)}`);
await p.locator('.tap-btn[aria-label="Pause video"]').tap();
await sleep(900);
check('the center button pauses', await p.evaluate(() => document.querySelector('.video-area video').paused));
await p.locator('.video-area .shield').tap();
await p.locator('.tap-btn[aria-label="Play video"]').tap();
await sleep(1200);
check('...and plays again', await p.evaluate(() => !document.querySelector('.video-area video').paused));

// camera remembered: on once, leave, rejoin -> it comes back on by itself (one prompt for mic + camera)
await p.locator('button:has-text("Join voice")').tap();
await p.waitForSelector('button:has-text("Camera off")', { timeout: 10000 });
await p.locator('button:has-text("Camera off")').tap();
await p.waitForSelector('button:has-text("Camera on")', { timeout: 10000 });
await p.locator('button:has-text("Camera on")').tap(); // off again: no new permission needed to turn it back on
await p.locator('button:has-text("Camera off")').tap();
check('turning the camera back on works straight away', await p.locator('button:has-text("Camera on")').waitFor({ timeout: 3000 }).then(() => true, () => false));
await p.locator('button:has-text("Leave voice")').tap();
await p.locator('button:has-text("Join voice")').tap();
check('rejoining voice brings the camera back on by itself', await p.locator('button:has-text("Camera on")').waitFor({ timeout: 10000 }).then(() => true, () => false));

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll UI checks passed.');
process.exit(failures ? 1 : 0);
