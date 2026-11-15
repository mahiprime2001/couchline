// Real-browser test of the player options on a hosted multi-track video: quality, audio track, subtitles,
// speed, keyboard shortcuts, lock-screen metadata, themes, and the queue's shuffle/repeat buttons.
//   node scripts/e2e-player.mjs <multi-track-video>      (needs the Node backend + Vite running)
// The video should be 720p+ with two audio tracks (440 Hz and 880 Hz tones) and an English subtitle track
// whose first cue is "Hello subtitle" around 1-4 s, so each option can be checked by measurement.
import { chromium } from 'playwright-core';
import { basename } from 'node:path';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/e2e-player.mjs <multi-track-video>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (n, ok, x = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${ok ? '' : '  ' + x}`);
  if (!ok) failures++;
};

const browser = await chromium.launch({ channel: process.env.CHANNEL ?? 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const vp = { width: 1366, height: 768 };
const mk = async () => (await browser.newContext({ viewport: vp })).newPage();

// the pitch of what the viewer is hearing: most common loudest frequency over `secs` seconds
const pitch = (p, secs = 2.5) =>
  p.evaluate(async (secs) => {
    const el = document.querySelector('video');
    if (!window.__an) {
      const ac = new AudioContext();
      await ac.resume();
      const an = ac.createAnalyser();
      an.fftSize = 8192;
      an.smoothingTimeConstant = 0;
      const src = ac.createMediaElementSource(el);
      src.connect(an);
      an.connect(ac.destination);
      window.__an = an;
      window.__ac = ac;
    }
    const an = window.__an, ac = window.__ac;
    const buf = new Float32Array(an.frequencyBinCount);
    const votes = new Map();
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) {
      an.getFloatFrequencyData(buf);
      let best = 1;
      for (let i = 2; i < buf.length; i++) if (buf[i] > buf[best]) best = i;
      if (buf[best] > -70) {
        const f = Math.round((best * ac.sampleRate) / an.fftSize / 20) * 20; // 20 Hz buckets
        votes.set(f, (votes.get(f) ?? 0) + 1);
      }
      await new Promise((r) => setTimeout(r, 80));
    }
    return [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0;
  }, secs);

const vstate = (p) => p.evaluate(() => { const v = document.querySelector('video'); return { cur: +v.currentTime.toFixed(1), paused: v.paused, rate: v.playbackRate, vol: +v.volume.toFixed(2), h: v.videoHeight }; });
const openMenu = async (p) => { await p.click('button[aria-label="Settings"]'); await p.waitForSelector('.settings-menu'); };
const choose = async (p, section, label) => {
  const sec = p.locator('.settings-menu section', { has: p.locator(`h5:text-is("${section}")`) });
  await sec.locator(`button:has-text("${label}")`).first().click();
};

// ---- host uploads the multi-track file
const host = await mk();
host.on('pageerror', (e) => console.log('   [host pageerror]', e.message));
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'Host');
await host.click('text=Create a room');
await host.waitForURL(/\/r\//);
const room = host.url();
await host.locator('button:has-text("Upload a file")').waitFor();
await sleep(800);
await host.locator('input[type=file][accept*="video"]').setInputFiles(file);
await host.waitForSelector('.hosted-status:has-text("Playing")', { timeout: 90000 });
check('multi-track video converted and playing', true);

// ---- viewer joins
const v = await mk();
v.on('pageerror', (e) => console.log('   [viewer pageerror]', e.message));
await v.goto(room);
await v.fill('input[placeholder="Your nickname"]', 'Viewer');
await v.click('button:has-text("Join")');
await v.waitForSelector('video');
await sleep(6000);

// ---- the settings menu lists what the file contains
const gear = v.locator('button[aria-label="Settings"]');
check('settings menu (gear) is shown', (await gear.count()) === 1);
await openMenu(v);
const menu = (await v.locator('.settings-menu').innerText()).replace(/\n+/g, ' | ');
const MENU = menu.toUpperCase(); // section headings are drawn in capitals
console.log('   menu:', menu);
check('quality choices: Auto, 720p, 480p, 360p', ['AUTO', '720P', '480P', '360P'].every((q) => MENU.includes(q)), menu);
check("audio choices use the file's own names", menu.includes('English') && menu.includes('Hindi commentary'), menu);
check('subtitle choices: Off, English', MENU.includes('SUBTITLES') && menu.includes('Off'), menu);
check('speed choices are offered to viewers', MENU.includes('SPEED') && menu.includes('2×'), menu);
await v.keyboard.press('Escape');

// ---- audio track: measure the pitch before and after
const p0 = await pitch(v);
check('default audio track is English (440 Hz)', Math.abs(p0 - 440) <= 40, `pitch=${p0} state=${JSON.stringify(await vstate(v))}`);
await openMenu(v);
await choose(v, 'Audio', 'Hindi commentary');
await sleep(4500);
const p1 = await pitch(v);
check('switching to "Hindi commentary" changes what you hear (880 Hz)', Math.abs(p1 - 880) <= 60, `pitch=${p1}`);
await openMenu(v);
await choose(v, 'Audio', 'English');
await sleep(4500);
const p2 = await pitch(v);
check('switching back to English works (440 Hz)', Math.abs(p2 - 440) <= 40, `pitch=${p2}`);

// ---- quality: the picture height must change
await openMenu(v);
await choose(v, 'Quality', '360p');
await sleep(6000);
const q360 = await vstate(v);
check('choosing 360p switches the picture to 360 pixels tall', q360.h === 360, JSON.stringify(q360));
await openMenu(v);
await choose(v, 'Quality', '720p');
await sleep(6000);
const q720 = await vstate(v);
check('choosing 720p switches back to 720 pixels tall', q720.h === 720, JSON.stringify(q720));
await openMenu(v);
await choose(v, 'Quality', 'Auto');
await v.keyboard.press('Escape');

// ---- subtitles from the file
await v.evaluate(() => { document.querySelector('video').currentTime = 2; }); // inside the first cue, and detaches the viewer
await sleep(800);
await openMenu(v);
await choose(v, 'Subtitles', 'English');
await sleep(1200);
const sub = await v.locator('.subtitle').allTextContents();
check('choosing the English subtitle track shows the text', sub.join(' ').includes('Hello subtitle'), JSON.stringify(sub));
await openMenu(v);
await choose(v, 'Subtitles', 'Off');
await sleep(600);
check('choosing Off hides the subtitles', (await v.locator('.subtitle').count()) === 0);

// ---- speed
await openMenu(v);
await choose(v, 'Speed', '2×');
await sleep(800);
const fast = await vstate(v);
check('2× speed is applied', fast.rate === 2, JSON.stringify(fast));
check('...and the viewer is offered "Go live" (own timeline now)', (await v.locator('button:has-text("Go live")').count()) > 0);
await v.keyboard.press('Escape');
await v.click('button:has-text("Go live")');
await sleep(800);
check('"Go live" puts speed back to normal', (await vstate(v)).rate === 1);

// ---- keyboard shortcuts
await v.mouse.click(683, 300); // focus the page body (the shield over the video does nothing)
await sleep(300);
await v.keyboard.press('k');
await sleep(500);
check('K pauses', (await vstate(v)).paused === true);
await v.keyboard.press('k');
await sleep(700);
check('K plays again', (await vstate(v)).paused === false);
const before = await vstate(v);
await v.keyboard.press('ArrowLeft');
await sleep(600);
const back = await vstate(v);
check('Left arrow goes back about 5 seconds', back.cur < before.cur - 3, JSON.stringify({ before, back }));
await v.keyboard.press('ArrowRight');
await v.keyboard.press('ArrowRight');
await v.keyboard.press('ArrowRight');
await v.keyboard.press('ArrowRight');
await sleep(1200);
const hostT = (await vstate(host)).cur;
const fwd = await vstate(v);
check('Right arrow can never pass the host (clamped to live)', fwd.cur <= hostT + 1.5, JSON.stringify({ fwd, hostT }));
const vol0 = (await vstate(v)).vol;
await v.keyboard.press('ArrowDown');
await sleep(300);
const vol1 = (await vstate(v)).vol;
check('Down arrow lowers the volume', vol1 < vol0, `${vol0} -> ${vol1}`);
await v.keyboard.press('m');
await sleep(300);
check('M mutes', (await vstate(v)).vol === 0);
await v.keyboard.press('m');
await sleep(300);
check('M unmutes', (await vstate(v)).vol > 0);

// typing in chat must not trigger shortcuts
await v.click('.tabs button:has-text("Chat")');
await v.click('.chat-form input');
const beforeType = await vstate(v);
await v.keyboard.type('k m f ');
await sleep(500);
const afterType = await vstate(v);
check('typing in the chat box does not trigger shortcuts', afterType.paused === beforeType.paused && afterType.vol === beforeType.vol);

// ---- lock-screen / media-key metadata
const ms = await v.evaluate(() => ({ title: navigator.mediaSession?.metadata?.title ?? null, state: navigator.mediaSession?.playbackState ?? null }));
check('lock-screen controls show the video title', ms.title === basename(file), JSON.stringify(ms));

// ---- queue: shuffle and repeat buttons
await host.click('.tabs button:has-text("Queue")');
await v.click('.tabs button:has-text("Queue")');
check('host sees Shuffle and Repeat buttons', (await host.locator('button:has-text("Shuffle")').count()) === 1 && (await host.locator('button:has-text("Repeat: off")').count()) === 1);
check('viewer sees Repeat but cannot change it', (await v.locator('button:has-text("Shuffle")').count()) === 0 && (await v.locator('button:has-text("Repeat: off")').isDisabled()));
await host.click('button:has-text("Repeat: off")');
await v.waitForSelector('button:has-text("Repeat: all")', { timeout: 4000 }).then(() => check('repeat setting reaches the viewer', true), () => check('repeat setting reaches the viewer', false));

// ---- themes
await v.click('button[aria-label="Room settings"]');
await v.click('button:has-text("Light")');
const th = await v.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }));
check('Light theme applies', th.theme === 'light' && th.bg !== 'rgb(14, 15, 19)', JSON.stringify(th));
await v.click('button[aria-label="Accent colour #14b8a6"]');
const ac = await v.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
check('accent colour applies', ac === '#14b8a6', ac);
await v.reload();
await v.waitForSelector('.tabs');
const kept = await v.evaluate(() => ({ theme: document.documentElement.dataset.theme, accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() }));
check('the theme and accent are remembered after a reload', kept.theme === 'light' && kept.accent === '#14b8a6', JSON.stringify(kept));
await v.screenshot({ path: process.env.SCREENSHOT ?? 'player-light.png' });

await browser.close();
console.log(failures === 0 ? '\nAll player checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
