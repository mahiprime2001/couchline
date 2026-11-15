// Real-browser test of the player chrome: the settings gear is always present, and fullscreen is a real
// full-screen player (video fills the screen, controls float and fade, menu works, Esc/double-click).
//   node scripts/e2e-controls.mjs <video.mp4>        (needs the Node backend + Vite running)
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const clip = process.argv[2];
if (!clip) {
  console.error('usage: node scripts/e2e-controls.mjs <video.mp4>');
  process.exit(2);
}
const OUT = process.env.SCREENSHOTS ?? tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + x}`);
  if (!ok) fails++;
};

const size = statSync(clip).size;
const server = createServer((req, res) => {
  const m = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
  const h = { 'content-type': 'video/mp4', 'accept-ranges': 'bytes' };
  if (m) {
    const s = +m[1], e = m[2] ? +m[2] : size - 1;
    res.writeHead(206, { ...h, 'content-range': `bytes ${s}-${e}/${size}`, 'content-length': e - s + 1 });
    createReadStream(clip, { start: s, end: e }).pipe(res);
  } else {
    res.writeHead(200, { ...h, 'content-length': size });
    createReadStream(clip).pipe(res);
  }
}).listen(0);
const url = `http://localhost:${server.address().port}/clip.mp4`;

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const mk = async () => {
  const c = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  await c.addInitScript(() => { delete window.showOpenFilePicker; });
  return c.newPage();
};

// ---------- link mode: host + viewer
const host = await mk();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'Host');
await host.click('text=Create a room');
await host.waitForURL(/\/r\//);
const room = host.url();
await host.fill('input[placeholder^="Paste a YouTube"]', url);
await host.click('text=Play for everyone');
await host.waitForSelector('video');
const v = await mk();
await v.goto(room);
await v.fill('input[placeholder="Your nickname"]', 'V');
await v.click('button:has-text("Join")');
await v.waitForSelector('video');
await sleep(3500);
check('the settings gear is shown for the host', (await host.locator('button[aria-label="Settings"]').count()) === 1);
check('the settings gear is shown for a viewer', (await v.locator('button[aria-label="Settings"]').count()) === 1);
await host.click('button[aria-label="Settings"]');
const hostMenu = await host.locator('.settings-menu').innerText();
check('host menu explains where quality/audio come from instead of being empty', hostMenu.includes('Upload') && hostMenu.includes('Keys:'), hostMenu.replace(/\n+/g, ' | '));
await host.keyboard.press('Escape');

const geo = (p) =>
  p.evaluate(() => {
    const r = (s) => {
      const e = document.querySelector(s);
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), h: Math.round(b.height) };
    };
    const c = document.querySelector('.controls');
    return {
      fs: !!document.fullscreenElement,
      vh: innerHeight,
      video: r('.video-area'),
      controls: r('.controls'),
      opacity: c ? getComputedStyle(c).opacity : null,
      idle: document.querySelector('.stage').classList.contains('idle'),
      menu: r('.settings-menu'),
    };
  });

const normal = await geo(host);
await host.click('button[title="Fullscreen"]');
await sleep(1000);
const fs1 = await geo(host);
await host.screenshot({ path: join(OUT, 'fs-after.png') });
check('fullscreen: the video fills the whole screen height', fs1.fs && fs1.video.h >= fs1.vh - 2, JSON.stringify(fs1));
check('fullscreen: the controls float over the bottom edge of the video', fs1.controls.bottom >= fs1.vh - 2 && fs1.controls.top > 400 && fs1.controls.top < fs1.vh, JSON.stringify(fs1.controls));
await sleep(3600);
const fs2 = await geo(host);
check('fullscreen: controls and cursor fade away after 3 s of no movement', fs2.idle && fs2.opacity === '0', JSON.stringify(fs2));
await host.mouse.move(600, 300);
await host.mouse.move(640, 330);
await sleep(500);
const fs3 = await geo(host);
check('fullscreen: moving the mouse brings them back', !fs3.idle && fs3.opacity === '1', JSON.stringify(fs3));
await host.click('button[aria-label="Settings"]');
await sleep(300);
const fs4 = await geo(host);
check('fullscreen: the settings menu opens and is fully on screen', !!fs4.menu && fs4.menu.top >= 0 && fs4.menu.bottom <= fs4.vh, JSON.stringify(fs4.menu));
// readable? WCAG contrast between the menu's text and its background must be at least 4.5
const contrast = await host.evaluate(() => {
  const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number);
  const lum = ([r, g, b]) => [r, g, b].map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }).reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const menu = document.querySelector('.settings-menu');
  const text = parse(getComputedStyle(menu.querySelector('p')).color);
  const bg = parse(getComputedStyle(menu).backgroundColor);
  const [a, b] = [lum(text), lum(bg)];
  return +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(1);
});
check('fullscreen: the menu text is readable (contrast at least 4.5:1)', contrast >= 4.5, `contrast ${contrast}:1`);
await host.screenshot({ path: join(OUT, 'fs-menu.png') });
await host.keyboard.press('Escape');
await host.evaluate(() => document.fullscreenElement && document.exitFullscreen());
await sleep(800);
const back = await geo(host);
check('leaving fullscreen restores the normal layout', !back.fs && back.video.h < back.vh - 100 && back.controls.bottom <= back.vh, JSON.stringify(back));
check('...and the normal layout is unchanged', Math.abs(back.video.h - normal.video.h) <= 2, JSON.stringify({ normal: normal.video, back: back.video }));
await host.locator('.shield').dblclick();
await sleep(800);
check('double-click on the video enters fullscreen', (await geo(host)).fs);
await host.evaluate(() => document.exitFullscreen());
await sleep(500);

// ---------- light theme in fullscreen: the controls must stay readable
await host.click('button[aria-label="Room settings"]');
await host.click('button:has-text("Light")');
await host.click('dialog button[aria-label="Close"]');
await host.click('button[title="Fullscreen"]');
await sleep(900);
const lightFs = await host.evaluate(() => ({ color: getComputedStyle(document.querySelector('.controls .time')).color, theme: document.documentElement.dataset.theme }));
check('light theme + fullscreen: control text stays light on the dark gradient', lightFs.theme === 'light' && lightFs.color.replace(/\s/g, '') === 'rgb(208,211,222)', JSON.stringify(lightFs));
await host.screenshot({ path: join(OUT, 'fs-light.png') });
await host.evaluate(() => document.exitFullscreen());

// ---------- live stream from the host's computer: the viewer gets a gear too
const sh = await mk();
await sh.goto(BASE);
await sh.fill('input[placeholder="e.g. Alex"]', 'Streamer');
await sh.click('text=Create a room');
await sh.waitForURL(/\/r\//);
const room2 = sh.url();
const [fc] = await Promise.all([sh.waitForEvent('filechooser'), sh.locator('button:has-text("Stream a file"), button:has-text("Choose a video file")').first().click()]);
await fc.setFiles(clip);
await sh.waitForSelector('text=STREAMING', { timeout: 15000 });
const sv = await mk();
await sv.goto(room2);
await sv.fill('input[placeholder="Your nickname"]', 'W');
await sv.click('button:has-text("Join")');
await sleep(7000);
check('live-stream viewer also has the settings gear (speed)', (await sv.locator('button[aria-label="Settings"]').count()) === 1);
await sv.click('button[aria-label="Settings"]');
await sv.locator('.settings-menu button:has-text("2×")').click();
await sleep(600);
check('live-stream viewer: 2x speed applies and "Go live" appears', (await sv.evaluate(() => document.querySelector('video').playbackRate)) === 2 && (await sv.locator('button:has-text("Go live")').count()) > 0);
await sv.click('button:has-text("Go live")');
await sleep(600);
check('"Go live" returns to normal speed', (await sv.evaluate(() => document.querySelector('video').playbackRate)) === 1);

await browser.close();
server.close();
console.log(fails ? `\n${fails} check(s) failed. Screenshots in ${OUT}` : `\nAll control checks passed. Screenshots in ${OUT}`);
process.exit(fails ? 1 : 0);
