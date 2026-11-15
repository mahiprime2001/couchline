// Generates a short animated WebM (video + audio tone) using Chrome itself, so tests need no ffmpeg.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function makeTestVideo(browser, seconds = 14) {
  const page = await (await browser.newContext()).newPage();
  await page.goto('about:blank');
  const b64 = await page.evaluate(async (secs) => {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const g = c.getContext('2d');
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const stream = c.captureStream(30);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8,opus' });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(500);
    const t0 = performance.now();
    await new Promise((res) => {
      const draw = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = `hsl(${(t * 40) % 360},70%,40%)`;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#fff';
        g.font = '80px sans-serif';
        g.fillText(t.toFixed(1), 220, 200);
        t < secs ? requestAnimationFrame(draw) : res();
      };
      draw();
    });
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, seconds);
  await page.context().close();
  const path = join(mkdtempSync(join(tmpdir(), 'wp-e2e-')), 'test-video.webm');
  writeFileSync(path, Buffer.from(b64, 'base64'));
  return path;
}
