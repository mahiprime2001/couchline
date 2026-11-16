// Real-browser test of link mode: host plays a link, viewers stay in sync, can rewind but never get ahead.
// Needs `pnpm dev` running and Chrome or Edge installed.   node scripts/e2e-link.mjs
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

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const file = await makeTestVideo(browser, 40);

// tiny static server with Range support, so <video> can seek
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
const videoUrl = `http://localhost:${server.address().port}/clip.webm`;

const host = await (await browser.newContext()).newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'HostUser');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();

await host.fill('input[placeholder^="Paste a YouTube"]', videoUrl);
await host.click('text=Play for everyone');
await host.waitForSelector('video', { timeout: 10000 });
check('host loaded the link', true);

const viewer = await (await browser.newContext()).newPage();
await viewer.goto(roomUrl);
await viewer.fill('input[placeholder="Your nickname"]', 'ViewerUser');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('video', { timeout: 10000 });

// In a room of 3 or fewer, everyone controls playback. Two more people make it 4, so the checks below are about
// a plain viewer (only the host and organizers control playback).
for (const nick of ['Extra1', 'Extra2']) {
  const extra = await (await browser.newContext()).newPage();
  await extra.goto(roomUrl);
  await extra.fill('input[placeholder="Your nickname"]', nick);
  await extra.click('button:has-text("Join")');
  await extra.waitForSelector('.room', { timeout: 10000 });
}
check('viewer is a plain viewer in a room of 4', await viewer.locator('text=Play for everyone').count().then(async (n) => {
  for (let i = 0; i < 20 && n > 0; i++) {
    await sleep(200);
    n = await viewer.locator('text=Play for everyone').count();
  }
  return n === 0;
}));

const t = (p) => p.evaluate(() => { const v = document.querySelector('video'); return { cur: v.currentTime, paused: v.paused, ready: v.readyState }; });
await sleep(4000);
const [h1, v1] = [await t(host), await t(viewer)];
check('both are playing', !h1.paused && !v1.paused, JSON.stringify({ h1, v1 }));
check('viewer is in sync with host (within 2s)', Math.abs(h1.cur - v1.cur) < 2, `host ${h1.cur.toFixed(1)} viewer ${v1.cur.toFixed(1)}`);

// host pauses -> viewer pauses
await host.click('button[aria-label="Pause"]');
await sleep(1500);
check('host pause reaches the viewer', (await t(viewer)).paused);
await host.click('button[aria-label="Play"]');
await sleep(1500);
check('host play reaches the viewer', !(await t(viewer)).paused);

// host pauses again -> a viewer can still press play and watch on their own past the host's frozen position
await host.click('button[aria-label="Pause"]');
await sleep(1500);
const frozen = await t(viewer);
await viewer.click('button[aria-label="Play"]');
await sleep(2500);
const own = await t(viewer);
check('viewer can play while the host is paused', !own.paused && own.cur > frozen.cur + 1, JSON.stringify({ frozen, own }));
await host.click('button[aria-label="Play"]');
await sleep(1500);

// viewer cannot control playback (no host-only controls) but can rewind
check('viewer has no "play for everyone" bar', (await viewer.locator('text=Play for everyone').count()) === 0);
await viewer.evaluate(() => { document.querySelector('video').currentTime = 1; });
await sleep(1200);
const rewound = await t(viewer);
check('viewer can rewind (stays behind host)', rewound.cur < (await t(host)).cur - 2, JSON.stringify(rewound));
check('"Go live" appears for a rewound viewer', (await viewer.locator('button:has-text("Go live")').count()) > 0);

// viewer tries to jump ahead of the host
const hostNow = (await t(host)).cur;
await viewer.evaluate((x) => { document.querySelector('video').currentTime = x; }, hostNow + 15);
await sleep(1200);
const ahead = await t(viewer);
const hostAfter = (await t(host)).cur;
check('viewer cannot get ahead of the host', ahead.cur <= hostAfter + 1, `viewer ${ahead.cur.toFixed(1)} host ${hostAfter.toFixed(1)}`);

// go live snaps back
await viewer.click('button:has-text("Go live")').catch(() => undefined);
await sleep(800);
const live = await t(viewer);
check('Go live returns to the host position', Math.abs(live.cur - (await t(host)).cur) < 2.5, JSON.stringify(live));

// chat + reactions reach the other side
await viewer.click('.tabs button:has-text("Chat")');
await viewer.fill('.chat-form input', 'hi from viewer');
await viewer.click('.chat-form button[type="submit"]');
check('chat reaches host', await host.locator('.msg:has-text("hi from viewer")').first().waitFor({ timeout: 4000 }).then(() => true, () => false));

// host leaves: link room keeps playing and the viewer is promoted
const before = await t(viewer);
await host.close();
const promoted = await viewer.waitForSelector('text=Play for everyone', { timeout: 8000 }).then(() => true, () => false);
check('viewer became host (sees the link bar)', promoted);
await sleep(2000);
const vAfter = await t(viewer);
check('room keeps playing after host leaves', !vAfter.paused && vAfter.cur > before.cur, JSON.stringify({ before, vAfter }));

server.close();
await browser.close();
console.log(failures === 0 ? '\nAll link e2e checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
