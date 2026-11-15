// Real-browser checks of the chat "+" menu (picture upload, GIF link, poll), the error pop-up for a link that
// cannot play, and the Video / Audio switch on top of the player.
// Needs `pnpm dev` running and Chrome or Edge installed.   BASE=http://localhost:5173 node scripts/e2e-chat.mjs
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
const waitFor = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await sleep(200);
  }
  return false;
};

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
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
const clip = `http://localhost:${server.address().port}/clip.webm`;

// ------------------------------------------------------------------ host + viewer
const hostCtx = await browser.newContext();
await hostCtx.addInitScript(() => {
  if (!sessionStorage.getItem('e2e-init')) {
    sessionStorage.setItem('e2e-init', '1');
    localStorage.setItem('wp-autoplay', '0');
    localStorage.removeItem('wp-watch');
  }
});
const host = await hostCtx.newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'ChatHost');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();
await host.waitForSelector('.chat-form input', { timeout: 10000 });

const viewer = await (await browser.newContext()).newPage();
await viewer.goto(roomUrl);
await viewer.fill('input[placeholder="Your nickname"]', 'ChatViewer');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('.chat-form input', { timeout: 10000 });

const PLUS = 'button[aria-label="Share a picture, GIF or poll"]';
const menuItems = async (page) => (await page.locator('.chat-menu [role="menuitem"]').allInnerTexts()).map((s) => s.trim());

// 1. the "+" menu: Picture, GIF and (host only) Poll
await host.click(PLUS);
const hostItems = await menuItems(host);
check('host "+" opens a menu with Picture, GIF and Poll', ['Picture', 'GIF', 'Poll'].every((w) => hostItems.some((t) => t.includes(w))), JSON.stringify(hostItems));
await host.click(PLUS); // close
check('clicking "+" again closes the menu', (await host.locator('.chat-menu').count()) === 0);
await viewer.click(PLUS);
const viewerItems = await menuItems(viewer);
check('viewer menu has Picture and GIF', ['Picture', 'GIF'].every((w) => viewerItems.some((t) => t.includes(w))), JSON.stringify(viewerItems));
check('viewer menu has no Poll', !viewerItems.some((t) => t.includes('Poll')), JSON.stringify(viewerItems));
await viewer.click(PLUS);

// 2. Picture: a PNG drawn in the page goes through the real file picker, uploads, and shows for both
const pngB64 = await host.evaluate(() => {
  const c = document.createElement('canvas');
  c.width = 40;
  c.height = 30;
  const g = c.getContext('2d');
  g.fillStyle = '#e33';
  g.fillRect(0, 0, 40, 30);
  g.fillStyle = '#33e';
  g.fillRect(10, 8, 20, 14);
  return c.toDataURL('image/png').split(',')[1];
});
await host.click(PLUS);
const [chooser] = await Promise.all([host.waitForEvent('filechooser', { timeout: 5000 }), host.click('.chat-menu [role="menuitem"]:has-text("Picture")')]);
const uploaded = host.waitForResponse((r) => r.url().includes('/api/chat-image') && r.request().method() === 'PUT', { timeout: 10000 });
await chooser.setFiles({ name: 'dot.png', mimeType: 'image/png', buffer: Buffer.from(pngB64, 'base64') });
const up = await uploaded.catch(() => null);
check('the picture uploads (PUT /api/chat-image → 200)', up?.status() === 200, up ? `status ${up.status()}` : 'no request');
const imgOk = (page) =>
  waitFor(() => page.locator('.chat-img img[src^="/chat-image/"]').first().evaluate((el) => el.complete && el.naturalWidth > 0), 10000);
check('host sees the picture in chat (naturalWidth > 0)', await imgOk(host));
check('viewer sees the picture in chat (naturalWidth > 0)', await imgOk(viewer));
check('the picture is 40 px wide as sent', (await viewer.locator('.chat-img img[src^="/chat-image/"]').first().evaluate((el) => el.naturalWidth).catch(() => 0)) === 40);

// 3. GIF link: a direct .gif link shows as an image; a page link only shows a warning
const GIF = 'https://media.giphy.com/media/v1.Y2lkPTc5MGI3NjEx/3o7aD2saalBwwftBIY/giphy.gif';
await host.click(PLUS);
await host.click('.chat-menu [role="menuitem"]:has-text("GIF")');
await host.fill('input[placeholder*="GIF link"]', GIF);
await host.click('.chat-extra button:has-text("Send")');
const gifSel = `.chat-img img[src="${GIF}"]`;
check('the GIF link arrives as an image for the viewer', await waitFor(async () => (await viewer.locator(gifSel).count()) === 1, 8000));
const gifLoaded = await waitFor(() => viewer.locator(gifSel).evaluate((el) => el.complete && el.naturalWidth > 0), 12000);
check('...and the GIF actually loads (naturalWidth > 0; needs internet)', gifLoaded);
check('the GIF box closes after sending', (await host.locator('.chat-extra').count()) === 0);

await viewer.click(PLUS);
await viewer.click('.chat-menu [role="menuitem"]:has-text("GIF")');
const msgsBefore = await host.locator('.chat-list .msg').count();
await viewer.fill('input[placeholder*="GIF link"]', 'https://example.com/page');
await viewer.click('.chat-extra button:has-text("Send")');
const warn = await viewer.locator('.chat-note.warn').innerText({ timeout: 3000 }).catch(() => '');
check('a non-image link shows a warning instead of sending', /direct GIF or picture link/i.test(warn), JSON.stringify(warn));
await sleep(800);
check('...and nothing was sent to the room', (await host.locator('.chat-list .msg').count()) === msgsBefore);
await viewer.click('.chat-extra button[aria-label="Close"]');

// 4. Poll: host starts it from "+", viewer sees it at the top of chat and votes, host sees the count
await host.click(PLUS);
await host.click('.chat-menu [role="menuitem"]:has-text("Poll")');
await host.fill('.poll-form input', 'Pizza or tacos?');
await host.fill('.poll-form textarea', 'Pizza\nTacos');
await host.click('.poll-form button:has-text("Start poll")');
const vPoll = viewer.locator('.chat-poll');
check('the viewer sees the poll', await vPoll.locator('text=Pizza or tacos?').waitFor({ timeout: 8000 }).then(() => true, () => false));
check('the poll sits at the top of the chat panel', await viewer.evaluate(() => {
  const p = document.querySelector('.panel.chat .chat-poll');
  const l = document.querySelector('.panel.chat .chat-list');
  return !!p && !!l && p.getBoundingClientRect().top < l.getBoundingClientRect().top;
}));
await vPoll.locator('.opt:has-text("Tacos")').click();
const tacos = () => host.locator('.chat-poll .opt:has-text("Tacos") .count').innerText();
check('the host sees the viewer\'s vote (Tacos = 1)', await waitFor(async () => (await tacos()).trim() === '1', 8000), await tacos().catch(() => '?'));
check('...and Pizza stays 0', (await host.locator('.chat-poll .opt:has-text("Pizza") .count').innerText()).trim() === '0');
check('the viewer\'s choice is marked', await waitFor(() => vPoll.locator('.opt:has-text("Tacos")').evaluate((el) => el.classList.contains('on'))));

// 5. Error pop-up: a link yt-dlp cannot play shows yt-dlp's reason, which goes away by itself after ~5 s
await host.fill('input[aria-label="Video link"]', 'https://example.com/page');
await host.click('button:has-text("Play for everyone")');
const toast = host.locator('.app-toast[role="alert"]');
const shown = await toast.waitFor({ timeout: 60000 }).then(() => true, () => false); // yt-dlp checks the link first
const shownAt = Date.now();
check('a pop-up appears for an unsupported link', shown);
check('...with yt-dlp\'s reason', /yt-dlp:/.test(await toast.innerText().catch(() => '')), await toast.innerText().catch(() => ''));
await sleep(3500);
check('...still showing after 3.5 s', (await toast.count()) === 1);
const goneAt = await waitFor(async () => (await toast.count()) === 0, 6500 - (Date.now() - shownAt));
check('...and gone by itself by ~6.5 s', goneAt, `still there after ${((Date.now() - shownAt) / 1000).toFixed(1)} s`);

// 6. Video / Audio switch on top of the player
await host.fill('input[aria-label="Video link"]', clip);
await host.click('button:has-text("Play for everyone")');
await host.waitForSelector('.video-area video', { timeout: 15000 });
const vt = () => host.evaluate(() => document.querySelector('.video-area video')?.currentTime ?? -1);
await waitFor(async () => (await vt()) > 1, 15000);
const sw = host.locator('.watch-switch');
check('the player shows a Video / Audio switch', (await sw.count()) === 1 && /Video/.test(await sw.innerText()) && /Audio/.test(await sw.innerText()));
check('Video is chosen by default, no cover screen', (await sw.locator('button:has-text("Video")').getAttribute('aria-pressed')) === 'true' && (await host.locator('.np-art').count()) === 0);
await sw.locator('button:has-text("Audio")').click();
check('Audio shows the cover screen', await host.locator('.np-art').isVisible().catch(() => false));
const t1 = await vt();
await sleep(2000);
const t2 = await vt();
check('the video keeps playing under the cover', t2 - t1 > 1 && !(await host.evaluate(() => document.querySelector('.video-area video').paused)), `${t1.toFixed(1)} -> ${t2.toFixed(1)}`);
check('the choice is saved (wp-watch = audio)', (await host.evaluate(() => localStorage.getItem('wp-watch'))) === 'audio');

await host.reload();
await host.waitForSelector('.watch-switch', { timeout: 15000 }).catch(() => {});
check('after a reload Audio is still chosen', (await host.locator('.watch-switch button:has-text("Audio")').getAttribute('aria-pressed').catch(() => null)) === 'true');
check('...and the cover screen is back', await host.locator('.np-art').isVisible().catch(() => false));
await host.locator('.watch-switch button:has-text("Video")').click();
check('Video hides the cover screen', (await host.locator('.np-art').count()) === 0);
check('...and saves wp-watch = video', (await host.evaluate(() => localStorage.getItem('wp-watch'))) === 'video');

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll chat checks passed.');
process.exit(failures ? 1 : 0);
