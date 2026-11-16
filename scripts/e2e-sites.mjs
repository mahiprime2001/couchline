// Real-browser checks of links from other video sites (fetched with yt-dlp), the full "Played" list, and organizers.
//  1. /api/yt/check gives a title for a site yt-dlp supports and yt-dlp's reason for one it does not; GIF search
//     says it needs a key when none is set
//  2. the host plays a Vimeo link: viewers see "Getting this video ready…", then the hosted copy plays with its title
//  3. a viewer's suggested site link shows its real title under Suggestions
//  4. every played item stays in "Played" (no show more / show fewer)
//  5. People tab: "make organizer" lets a viewer play / pause for everyone, "remove organizer" takes it back
// Needs the backend with yt-dlp, internet, and Chrome or Edge.   BASE=http://localhost:5173 node scripts/e2e-sites.mjs
// SITE / SITE_TITLE / SUGGEST / SUGGEST_TITLE override the links. Vimeo is only used for the failure path: on this
// machine vimeo.com/<id> needs a login and player.vimeo.com/video/<id> is DRM protected for yt-dlp.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { makeTestVideo } from './testvideo.mjs';

const BASE = process.env.BASE ?? 'http://localhost:5173';
const SITE = process.env.SITE ?? 'https://www.dailymotion.com/video/x7tgad0';
const SITE_TITLE = process.env.SITE_TITLE ?? 'Midnight Sun';
// Vimeo: yt-dlp reads its title, but the download is DRM protected, so it must fail with yt-dlp's reason
const VIMEO = process.env.VIMEO ?? 'https://player.vimeo.com/video/76979871';
const VIMEO_TITLE = 'The New Vimeo Player';
const SUGGEST = process.env.SUGGEST ?? 'https://archive.org/details/Popeye_forPresident';
const SUGGEST_TITLE = process.env.SUGGEST_TITLE ?? 'Popeye for President';

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
    await sleep(250);
  }
  return false;
};
const getJson = async (path) => {
  const r = await fetch(BASE + path);
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ------------------------------------------------------------------ 1. API level
const health = await getJson('/api/health');
check('health: yt-dlp is available', health.body?.media?.ytdlp === true, JSON.stringify(health.body));
check('health: "gifs" is false with no GIF key', health.body?.gifs === false, JSON.stringify(health.body));

const good = await getJson(`/api/yt/check?url=${encodeURIComponent(SITE)}`);
check(`yt/check gives a title for ${SITE}`, good.status === 200 && typeof good.body.title === 'string' && good.body.title.includes(SITE_TITLE), `${good.status} ${JSON.stringify(good.body)}`);
const vim = await getJson(`/api/yt/check?url=${encodeURIComponent(VIMEO)}`);
check(`yt/check gives a title for ${VIMEO}`, vim.status === 200 && (vim.body.title ?? '').includes(VIMEO_TITLE), `${vim.status} ${JSON.stringify(vim.body)}`);
const plain = await getJson(`/api/yt/check?url=${encodeURIComponent('https://vimeo.com/76979871')}`);
console.log(`info  vimeo.com/76979871 itself → ${plain.status} ${JSON.stringify(plain.body).slice(0, 160)}`);
const bad = await getJson(`/api/yt/check?url=${encodeURIComponent('https://example.com/page')}`);
check('yt/check on an unsupported page fails with yt-dlp\'s reason', bad.status >= 400 && /\[generic\]|Unsupported|Unable/i.test(bad.body.error ?? ''), `${bad.status} ${JSON.stringify(bad.body)}`);
const notHttps = await getJson(`/api/yt/check?url=${encodeURIComponent('ftp://x')}`);
check('yt/check rejects a non-https link (400)', notHttps.status === 400, `${notHttps.status}`);
const gif = await getJson('/api/gif/search?q=cat');
check('gif/search answers 501 naming GIPHY_KEY / TENOR_KEY', gif.status === 501 && /GIPHY_KEY/.test(gif.body.error ?? '') && /TENOR_KEY/.test(gif.body.error ?? ''), `${gif.status} ${JSON.stringify(gif.body)}`);

// ------------------------------------------------------------------ browsers + local clips
const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? 'chrome',
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required'],
});

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
const clip = (name) => `http://localhost:${server.address().port}/${name}.webm`;

const hostCtx = await browser.newContext();
await hostCtx.addInitScript(() => {
  if (!sessionStorage.getItem('e2e-init')) {
    sessionStorage.setItem('e2e-init', '1');
    localStorage.setItem('wp-autoplay', '0');
    localStorage.removeItem('wp-watch');
    localStorage.removeItem('wp-music');
  }
});
const host = await hostCtx.newPage();
await host.goto(BASE);
await host.fill('input[placeholder="e.g. Alex"]', 'SitesHost');
await host.click('text=Create a room');
await host.waitForURL(/\/r\/[A-Z0-9]{6}/);
const roomUrl = host.url();
await host.waitForSelector('input[aria-label="Video link"]', { timeout: 10000 });

const viewerCtx = await browser.newContext();
await viewerCtx.addInitScript(() => localStorage.removeItem('wp-watch'));
const viewer = await viewerCtx.newPage();
await viewer.goto(roomUrl);
await viewer.fill('input[placeholder="Your nickname"]', 'SitesViewer');
await viewer.click('button:has-text("Join")');
await viewer.waitForSelector('.chat-form input', { timeout: 10000 });

// In a room of 3 or fewer, everyone controls playback. Two more people make it 4, so the viewer here is a plain
// viewer and "make organizer" is what gives them control.
for (const nick of ['Extra1', 'Extra2']) {
  const extra = await (await browser.newContext()).newPage();
  await extra.goto(roomUrl);
  await extra.fill('input[placeholder="Your nickname"]', nick);
  await extra.click('button:has-text("Join")');
  await extra.waitForSelector('.room', { timeout: 10000 });
}

const tab = (page, name) => page.click(`.tabs button:has-text("${name}")`);
const vtime = (page) => page.evaluate(() => document.querySelector('.video-area video')?.currentTime ?? -1);
const paused = (page) => page.evaluate(() => document.querySelector('.video-area video')?.paused ?? null);
const advancing = async (page, ms = 2000) => {
  const a = await vtime(page);
  await sleep(ms);
  const b = await vtime(page);
  return { ok: a >= 0 && b - a > 0.5, a, b };
};

// ------------------------------------------------------------------ 2. host plays a site link
await host.fill('input[aria-label="Video link"]', SITE);
await host.click('button:has-text("Play for everyone")');
const overlay = viewer.locator('.video-area .overlay-msg:has-text("Getting this video ready")');
check('the viewer sees "Getting this video ready…" first', await overlay.waitFor({ timeout: 60000 }).then(() => true, () => false));
const hosted = await waitFor(
  () => viewer.evaluate(() => {
    const v = document.querySelector('.video-area video');
    return !!v && v.currentTime > 1;
  }),
  240000,
);
check('the hosted copy then plays for the viewer (<video> currentTime > 1)', hosted);
const adv = await advancing(viewer);
check('...and keeps advancing', adv.ok, `${adv.a.toFixed(1)} -> ${adv.b.toFixed(1)}`);
check('the overlay is gone once it plays', (await overlay.count()) === 0);
await tab(viewer, 'Queue');
const nowText = await viewer.locator('.now-playing .qtitle').innerText({ timeout: 10000 }).catch(() => '');
check('Queue → "Now playing" shows the site\'s real title', nowText.includes(SITE_TITLE), JSON.stringify(nowText));

// ------------------------------------------------------------------ 3. a viewer suggests a site link
await viewer.fill('input[aria-label="Search YouTube or paste a link"]', SUGGEST);
await viewer.click('.queue-search button[type="submit"]');
await viewer.click('.subtabs button:has-text("Suggestions")');
const sugg = viewer.locator('.queue-panel .queue li .qname');
const suggOk = await waitFor(async () => (await sugg.allInnerTexts()).some((t) => t.includes(SUGGEST_TITLE)), 90000);
check('the suggestion shows under Suggestions with its real title', suggOk, JSON.stringify(await sugg.allInnerTexts().catch(() => [])));
check('...not the raw URL', !(await sugg.allInnerTexts().catch(() => [])).some((t) => t.includes(SUGGEST)));
await tab(host, 'Queue');
await host.click('.subtabs button:has-text("Suggestions")');
check('the host sees it with the same title', await waitFor(async () => (await host.locator('.queue-panel .queue li .qname').allInnerTexts()).some((t) => t.includes(SUGGEST_TITLE)), 8000));
// an unsupported page is never suggested: the viewer gets yt-dlp's reason instead
const pendingBefore = await host.locator('.queue-panel .queue li').count();
await viewer.fill('input[aria-label="Search YouTube or paste a link"]', 'https://example.com/page');
await viewer.click('.queue-search button[type="submit"]');
const vtoast = viewer.locator('.app-toast[role="alert"]');
check('suggesting an unsupported page shows yt-dlp\'s reason', await vtoast.waitFor({ timeout: 60000 }).then(async () => /yt-dlp:/.test(await vtoast.innerText()), () => false));
await sleep(800);
check('...and nothing is added', (await host.locator('.queue-panel .queue li').count()) === pendingBefore);

// ------------------------------------------------------------------ 4. Played list shows everything
const clips = ['first', 'second', 'third', 'fourth'];
for (const name of clips) {
  await host.fill('input[aria-label="Video link"]', clip(name));
  await host.click('button:has-text("Play for everyone")');
  await waitFor(() => host.evaluate((n) => (document.querySelector('.video-area video')?.currentSrc ?? '').includes(`/${n}.webm`), name), 15000);
  await waitFor(async () => (await vtime(host)) > 0.5, 10000);
}
await host.click('.subtabs button:has-text("Playing now")');
await tab(viewer, 'Queue');
await viewer.click('.subtabs button:has-text("Playing now")');
for (const [who, page] of [['host', host], ['viewer', viewer]]) {
  const want = [SITE_TITLE, 'first.webm', 'second.webm', 'third.webm'];
  const got = async () => page.locator('.queue.played li .qname').allInnerTexts();
  const allThere = await waitFor(async () => {
    const g = await got();
    return want.every((w) => g.some((t) => t.includes(w)));
  }, 10000);
  check(`${who}: Played lists every played item (the site + 3 clips)`, allThere, JSON.stringify(await got()));
  const head = await page.locator('.queue-panel h4:has-text("Played")').innerText().catch(() => '');
  const n = (await got()).length;
  check(`${who}: the "Played (n)" count matches the rows shown`, head.includes(`(${n})`), `${head} vs ${n} rows`);
  const moreBtns = await page.locator('.queue-panel button').allInnerTexts();
  check(`${who}: no "Show … earlier" / "Show fewer" button`, !moreBtns.some((t) => /show .*earlier|show fewer|show more|show less/i.test(t)), JSON.stringify(moreBtns.filter((t) => /show/i.test(t))));
}
check('the site item in Played keeps its title (not the copy\'s file name)', !(await host.locator('.queue.played li .qname').allInnerTexts()).some((t) => /index\.m3u8|master\.m3u8/.test(t)));

// ------------------------------------------------------------------ 5. organizer
await waitFor(async () => (await vtime(viewer)) > 0.5, 10000);
await tab(host, 'People');
await tab(viewer, 'People');
const hostRow = host.locator('.people li', { hasText: 'SitesViewer' });
const makeBtn = hostRow.locator('button:has-text("make organizer")');
check('the host sees "make organizer" for the viewer', (await makeBtn.count()) === 1);
check('the viewer sees no "make organizer" buttons', (await viewer.locator('button:has-text("make organizer")').count()) === 0);
await makeBtn.click();
check('the host sees an Organizer tag on the viewer', await waitFor(async () => (await hostRow.locator('.role-tag:has-text("Organizer")').count()) === 1, 5000));
check('the viewer sees the Organizer tag on themselves', await waitFor(async () => (await viewer.locator('.people li', { hasText: 'SitesViewer' }).locator('.role-tag:has-text("Organizer")').count()) === 1, 5000));
check('the host\'s button now says "remove organizer"', (await hostRow.locator('button:has-text("remove organizer")').count()) === 1);
check('the organizer now gets the "Play for everyone" box', await viewer.locator('input[aria-label="Video link"]').waitFor({ timeout: 5000 }).then(() => true, () => false));

const press = (page, label) => page.evaluate((l) => {
  const b = document.querySelector(`.controls-row button[aria-label="${l}"]`);
  if (!b) return false;
  b.click();
  return true;
}, label);
check('host is playing before the organizer pauses', (await paused(host)) === false);
check('the organizer\'s Pause button is there', await press(viewer, 'Pause'));
check('...and it pauses the host\'s player too', await waitFor(async () => (await paused(host)) === true, 6000), `host paused=${await paused(host)}`);
await sleep(500);
check('the organizer\'s Play button is there', await press(viewer, 'Play'));
check('...and it resumes the host\'s player', await waitFor(async () => (await paused(host)) === false, 6000), `host paused=${await paused(host)}`);
const hadv = await advancing(host);
check('...which keeps advancing', hadv.ok, `${hadv.a.toFixed(1)} -> ${hadv.b.toFixed(1)}`);

// the organizer can load a video for everyone
await viewer.fill('input[aria-label="Video link"]', clip('organizer'));
await viewer.click('button:has-text("Play for everyone")');
check('the organizer can load a video for everyone', await waitFor(() => host.evaluate(() => (document.querySelector('.video-area video')?.currentSrc ?? '').includes('/organizer.webm')), 15000));
await waitFor(async () => (await vtime(host)) > 0.5 && (await vtime(viewer)) > 0.5, 10000);

await hostRow.locator('button:has-text("remove organizer")').click();
check('"remove organizer" removes the tag', await waitFor(async () => (await hostRow.locator('.role-tag').count()) === 0, 5000));
check('...the viewer no longer sees the tag', await waitFor(async () => (await viewer.locator('.people li', { hasText: 'SitesViewer' }).locator('.role-tag').count()) === 0, 5000));
check('...the "Play for everyone" box goes away', await waitFor(async () => (await viewer.locator('input[aria-label="Video link"]').count()) === 0, 5000));
check('...and "make organizer" is back', (await hostRow.locator('button:has-text("make organizer")').count()) === 1);
await waitFor(async () => (await paused(host)) === false, 3000);
await press(viewer, 'Pause');
await sleep(2000);
check('a plain viewer\'s Pause no longer pauses the host', (await paused(host)) === false, `host paused=${await paused(host)}`);

// ------------------------------------------------------------------ 6. a site link yt-dlp cannot download
// (Vimeo here: the check finds a title, the download hits DRM). Nothing is in Up next, so there is nothing to skip to.
await host.fill('input[aria-label="Video link"]', VIMEO);
await host.click('button:has-text("Play for everyone")');
const failMsg = await host.locator('.app-toast[role="alert"]', { hasText: 'could not get' }).innerText({ timeout: 120000 }).catch(() => '');
check('a site link that fails to download shows yt-dlp\'s reason to the host', /yt-dlp could not get this video/.test(failMsg), JSON.stringify(failMsg));
const vOverlay = viewer.locator('.overlay-msg:has-text("Getting this video ready")');
const cleared = await waitFor(async () => (await vOverlay.count()) === 0, 15000);
check('...and the viewer is not left on "Getting this video ready…" (nothing in Up next)', cleared, 'overlay still showing 15 s after the failure');

await browser.close();
server.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll site / played / organizer checks passed.');
process.exit(failures ? 1 : 0);
