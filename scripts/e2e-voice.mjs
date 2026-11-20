// Real-browser test of voice through the room server: listening without joining, the speaking outline, mute badges,
// an organizer's mute silencing someone, and voice coming back by itself after the connection drops.
// Uses Chrome's fake microphone (a beep) and camera. Needs `pnpm dev` running and Chrome or Edge installed.
//   node scripts/e2e-voice.mjs
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
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
const newContext = async () => {
  // INSECURE=1 accepts a self-made certificate, e.g. the deploy/ setup tried on this computer with DOMAIN=localhost
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'], ignoreHTTPSErrors: !!process.env.INSECURE });
  // count every piece of someone else's sound that gets played, and keep the page's sockets so a test can drop one
  await ctx.addInitScript(() => {
    window.__sockets = [];
    const Native = window.WebSocket;
    window.WebSocket = class extends Native {
      constructor(...a) {
        super(...a);
        window.__sockets.push(this);
      }
    };
    window.__sound = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) {
      window.__sound++;
      return start.apply(this, a);
    };
  });
  return ctx;
};

const hostCtx = await newContext();
const host = await hostCtx.newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'Alex');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();

const talkerCtx = await newContext();
const talker = await talkerCtx.newPage();
await talker.goto(roomUrl);
await talker.fill('input[placeholder="Your nickname"]', 'Sam');
await talker.click('button:has-text("Join")');
await talker.waitForSelector('.room', { timeout: 10000 });

const sound = () => host.evaluate(() => window.__sound);
/** How much of Sam's sound the host plays over `ms` milliseconds. */
const soundOver = async (ms) => {
  const before = await sound();
  await sleep(ms);
  return (await sound()) - before;
};
const samTile = host.locator('.call-tile:has(.call-name:text-is("Sam"))');
const badgeTitle = () => samTile.locator('.call-muted').getAttribute('title', { timeout: 500 }).catch(() => null);

// ---- 1. the host only watches: Sam joins voice, the host hears Sam without joining
await host.mouse.click(5, 5); // a tap lets the page start sound
await talker.click('button:has-text("Join voice")');
await talker.waitForSelector('button:has-text("Leave voice")', { timeout: 10000 });
await samTile.waitFor({ timeout: 10000 });
check('the host hears Sam without joining voice', (await soundOver(3000)) > 50);
check('the host is still outside voice', (await host.locator('button:has-text("Join voice")').count()) === 1);

// ---- 2. the speaking outline (the fake microphone beeps once a second)
let outlined = false;
for (let i = 0; i < 30 && !outlined; i++) {
  outlined = (await samTile.getAttribute('class'))?.includes('speaking') ?? false;
  if (!outlined) await sleep(100);
}
check("Sam's tile is outlined while Sam talks", outlined);

// ---- 3. Sam mutes: the others see it, and hear nothing
await talker.click('button:has-text("Live")');
await sleep(1500);
check('Sam muting shows "Microphone off" on their tile for the host', (await badgeTitle()) === 'Microphone off', String(await badgeTitle()));
await sleep(500);
check('...and the host hears nothing from Sam', (await soundOver(2000)) <= 3);
await talker.click('button:has-text("Muted")');
await sleep(1500);
check('Sam unmuting removes the badge', (await badgeTitle()) === null, String(await badgeTitle()));
check('...and the host hears Sam again', (await soundOver(2000)) > 30);

// ---- 4. the host mutes Sam as an organizer: Sam's sound is dropped by the server
await host.click('.tabs button:has-text("People")');
const samRow = host.locator('.people li:has-text("Sam")');
await samRow.locator('button', { hasText: /^mute$/ }).click();
await talker.waitForSelector('button:has-text("Muted by an organizer")', { timeout: 5000 }).catch(() => undefined);
check("Sam's bar says they were muted by an organizer", (await talker.locator('button:has-text("Muted by an organizer")').count()) === 1);
await sleep(1000);
check('the host sees "Muted by the host or an organizer" on Sam\'s tile', (await badgeTitle()) === 'Muted by the host or an organizer', String(await badgeTitle()));
check('...and hears nothing from Sam', (await soundOver(2000)) <= 3);
await samRow.locator('button', { hasText: /^unmute$/ }).click();
await sleep(1500);
check('after the organizer unmutes Sam, the host hears Sam again', (await soundOver(2000)) > 30);

// ---- 5. Sam's connection drops and comes back: voice resumes by itself, no re-join
// (closing the page's socket is what a network drop looks like to the app; it reconnects by itself)
const socketsBefore = await talker.evaluate(() => window.__sockets.length);
await talker.evaluate(() => window.__sockets.at(-1).close());
await sleep(500);
check("Sam's page noticed the drop", (await talker.locator('.banner:has-text("Reconnecting")').count()) === 1);
await sleep(4000);
check('...and reconnected', (await talker.evaluate(() => window.__sockets.length)) > socketsBefore);
let back = false;
for (let i = 0; i < 15 && !back; i++) {
  await sleep(1000);
  back = (await talker.locator('.banner:has-text("Reconnecting")').count()) === 0 && (await soundOver(1000)) > 20;
}
check("after Sam's connection drops and returns, the host hears Sam again without a re-join", back);
check('...and Sam is still shown in voice', (await talker.locator('button:has-text("Leave voice")').count()) === 1 && (await samTile.count()) === 1);

await browser.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll voice checks passed.');
process.exit(failures ? 1 : 0);
