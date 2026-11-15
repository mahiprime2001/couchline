// Tests the server's "YouTube-style" hosting: upload -> ffmpeg -> HLS chunks, host-only uploads, cleanup.
//   node scripts/smoke-media.mjs <base-url> <video-file> [<video-file> ...]
// e.g. node scripts/smoke-media.mjs http://localhost:8787 clip.mp4 ac3.mkv
import http from 'node:http';
import { createReadStream, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const BASE = process.argv[2] ?? 'http://localhost:8787';
const files = process.argv.slice(3);
const WS = BASE.replace(/^http/, 'ws');
const tmp = mkdtempSync(join(tmpdir(), 'wp-media-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};

async function createRoom() {
  const { code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();
  const ws = new WebSocket(`${WS}/ws/${code}`);
  const token = await new Promise((resolve, reject) => {
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', nick: 'Host', sessionId: crypto.randomUUID(), create: true }));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.t === 'welcome') resolve(m.hostToken); };
    ws.onerror = reject;
  });
  return { code, token, ws };
}

function put(path, file, headers) {
  return new Promise((resolve, reject) => {
    const size = statSync(file).size;
    const u = new URL(BASE + path);
    const req = http.request({ method: 'PUT', hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: { 'content-length': size, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    });
    // a refused upload may be cut off by the server after its answer: report what we got instead of crashing
    req.on('error', (e) => resolve({ status: 0, body: { error: e.code ?? e.message } }));
    createReadStream(file).on('error', () => {}).pipe(req);
  });
}

const getJson = async (path) => { const r = await fetch(BASE + path); return { status: r.status, body: await r.json().catch(() => null) }; };
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name', '-of', 'json', file]).toString()).streams.map((s) => `${s.codec_type}:${s.codec_name}`);

const health = await getJson('/api/health');
check('server reports hosting is available', health.body?.media?.available === true, JSON.stringify(health.body));
if (!health.body?.media?.available) process.exit(1);

const { code, token, ws } = await createRoom();

// ---- access control
const f0 = files[0];
const noToken = await put(`/api/media?room=${code}&name=x`, f0, {});
check('upload without the host token is refused', noToken.status === 403, JSON.stringify(noToken));
const badToken = await put(`/api/media?room=${code}&name=x`, f0, { 'x-host-token': 'nope' });
check('upload with a wrong token is refused', badToken.status === 403, JSON.stringify(badToken));
const otherRoom = await put(`/api/media?room=ZZZZZZ&name=x`, f0, { 'x-host-token': token });
check('upload to a room that does not exist is refused', otherRoom.status === 403, JSON.stringify(otherRoom));
check('unknown media id is a 404', (await getJson('/api/media/00000000-0000-4000-8000-000000000000')).status === 404);
const trick = await (await fetch(`${BASE}/media/00000000-0000-4000-8000-000000000000/..%2f..%2fpackage.json`)).text();
check('path tricks do not read files outside the media folder', !trick.includes('"name": "video-sharing"'), trick.slice(0, 80));

// ---- each file: upload, convert, inspect
for (const file of files) {
  const label = basename(file);
  const t0 = Date.now();
  const up = await put(`/api/media?room=${code}&name=${encodeURIComponent(label)}`, file, { 'x-host-token': token });
  check(`${label}: upload accepted`, up.status === 200 && !!up.body?.id, JSON.stringify(up));
  if (up.status !== 200) continue;
  const id = up.body.id;
  let st;
  let sawPlayableWhileConverting = false;
  for (let i = 0; i < 240; i++) {
    st = (await getJson(`/api/media/${id}`)).body;
    if (st.state === 'converting' && st.playable) sawPlayableWhileConverting = true;
    if (st.state === 'done' || st.state === 'error') break;
    await sleep(500);
  }
  check(`${label}: converted (${((Date.now() - t0) / 1000).toFixed(1)}s, ${st.segments} chunks)`, st.state === 'done', JSON.stringify(st));
  if (st.state !== 'done') continue;
  // simple output opens index.m3u8; multi-quality / multi-audio output opens master.m3u8 (a list of variants)
  const entry = st.entry ?? 'index.m3u8';
  let list = await (await fetch(`${BASE}/media/${id}/${entry}`)).text();
  const master = entry === 'master.m3u8' ? list : null;
  if (master) {
    const firstVariant = master.split('\n').map((l) => l.trim()).find((l) => /^stream_[\w-]+\.m3u8$/.test(l));
    list = await (await fetch(`${BASE}/media/${id}/${firstVariant}`)).text();
  }
  const segs = list.match(/^seg_[\w-]+\.ts$/gm) ?? [];
  check(`${label}: playlist lists the chunks and ends properly`, segs.length > 0 && list.includes('#EXT-X-ENDLIST'), list.slice(0, 200));
  const seg = await fetch(`${BASE}/media/${id}/${segs[0]}`);
  const bytes = Buffer.from(await seg.arrayBuffer());
  check(`${label}: first chunk downloads`, seg.status === 200 && bytes.length > 1000 && seg.headers.get('content-type') === 'video/mp2t', `${seg.status} ${bytes.length}`);
  const part = await fetch(`${BASE}/media/${id}/${segs[0]}`, { headers: { range: 'bytes=0-99' } });
  check(`${label}: chunk supports Range requests`, part.status === 206 && (await part.arrayBuffer()).byteLength === 100);
  const segFile = join(tmp, `${label}.ts`);
  writeFileSync(segFile, bytes);
  const streams = probe(segFile);
  console.log(`   ${label} chunk streams: ${streams.join(', ')}  (playable while still converting: ${sawPlayableWhileConverting})`);
  const hasVideo = streams.some((s) => s.startsWith('video:'));
  const hasAudio = streams.some((s) => s === 'audio:aac');
  const sourceStreams = probe(file);
  const tracks = await (await fetch(`${BASE}/media/${id}/tracks.json`)).json().catch(() => null);
  check(`${label}: tracks.json describes the audio, subtitles and qualities`, !!tracks && Array.isArray(tracks.audio) && Array.isArray(tracks.subtitles) && Array.isArray(tracks.heights), JSON.stringify(tracks));
  if (!master) {
    check(`${label}: sound is AAC in the output when the source had sound`, sourceStreams.some((s) => s.startsWith('audio:')) ? hasAudio : !streams.some((s) => s.startsWith('audio:')), streams.join(','));
    check(`${label}: picture is kept`, sourceStreams.some((s) => s.startsWith('video:')) ? hasVideo : true, streams.join(','));
  } else {
    // multi-variant: video chunks are video-only, each audio track is its own playlist
    const levels = (master.match(/#EXT-X-STREAM-INF/g) ?? []).length;
    const audioRenditions = [...master.matchAll(/#EXT-X-MEDIA:TYPE=AUDIO[^\n]*URI="([^"]+)"/g)].map((m) => m[1]);
    console.log(`   ${label}: ${levels} video qualities ${JSON.stringify(tracks?.heights)}, ${audioRenditions.length} audio tracks ${JSON.stringify((tracks?.audio ?? []).map((a) => a.name))}, subtitles ${JSON.stringify((tracks?.subtitles ?? []).map((s) => s.name))}`);
    check(`${label}: master playlist offers several qualities`, levels === tracks.heights.length && levels >= 2, `levels=${levels} heights=${tracks?.heights}`);
    check(`${label}: picture is kept (H.264 chunks)`, hasVideo, streams.join(','));
    const sourceAudio = sourceStreams.filter((s) => s.startsWith('audio:')).length;
    check(`${label}: every audio track of the source became a selectable track`, audioRenditions.length === sourceAudio, `${audioRenditions.length} vs ${sourceAudio}`);
    for (const uri of audioRenditions) {
      const pl = await (await fetch(`${BASE}/media/${id}/${uri}`)).text();
      const first = pl.match(/^seg_[\w-]+\.ts$/m)?.[0];
      const buf = Buffer.from(await (await fetch(`${BASE}/media/${id}/${first}`)).arrayBuffer());
      const f = join(tmp, `${label}-${uri}.ts`);
      writeFileSync(f, buf);
      check(`${label}: audio track ${uri} carries AAC sound`, probe(f).includes('audio:aac'), probe(f).join(','));
    }
    for (const s of tracks?.subtitles ?? []) {
      const vtt = await (await fetch(`${BASE}/media/${id}/${s.url}`)).text();
      check(`${label}: subtitle "${s.name}" is served as WebVTT`, vtt.startsWith('WEBVTT') && vtt.includes('-->'), vtt.slice(0, 60));
    }
  }
}

// ---- a file that is not media at all
const junk = join(tmp, 'junk.bin');
writeFileSync(junk, Buffer.alloc(50_000, 7));
const junkUp = await put(`/api/media?room=${code}&name=junk.bin`, junk, { 'x-host-token': token });
let js;
for (let i = 0; i < 40 && junkUp.status === 200; i++) { js = (await getJson(`/api/media/${junkUp.body.id}`)).body; if (js.state === 'error' || js.state === 'done') break; await sleep(250); }
check('a non-media file ends in a clear error, not a hang', js?.state === 'error' && !!js.error, JSON.stringify(js));

// ---- cleanup: closing the room removes its files (grace period is minutes, so test the per-room cap instead)
const ids = [];
for (let i = 0; i < 3; i++) { const r = await put(`/api/media?room=${code}&name=cap${i}`, f0, { 'x-host-token': token }); if (r.status === 200) ids.push(r.body.id); }
const first = await getJson(`/api/media/${ids[0]}`);
check('each room keeps only its most recent hosted videos (old ones are deleted)', first.status === 404 && (await getJson(`/api/media/${ids[2]}`)).status === 200, `first=${first.status}`);

ws.close();
console.log(failures === 0 ? '\nAll media checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
