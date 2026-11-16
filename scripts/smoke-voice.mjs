// Server test for voice, camera and the host's stream, which travel as binary WebSocket frames (see MEDIA_HEADER in
// packages/shared/src/protocol.ts). Needs a running backend: `pnpm dev` first.
//   node scripts/smoke-voice.mjs [http://localhost:8787]
// Uses Node's built-in WebSocket. Exits non-zero if any check fails.

const BASE = process.argv[2] ?? 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');
let failures = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { code } = await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json();

function client(nick, create) {
  const ws = new WebSocket(`${WS}/ws/${code}`);
  ws.binaryType = 'arraybuffer';
  const c = { ws, nick, json: [], binary: [], closed: false, id: null };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') {
      const m = JSON.parse(e.data);
      c.json.push(m);
      if (m.t === 'welcome') c.id = m.you.id;
    } else c.binary.push(new Uint8Array(e.data));
  };
  ws.onclose = () => (c.closed = true);
  c.send = (m) => ws.send(JSON.stringify(m));
  c.ready = new Promise((res) => (ws.onopen = res)).then(async () => {
    c.send({ t: 'join', nick, sessionId: crypto.randomUUID(), create: create || undefined });
    for (let i = 0; i < 50 && !c.id; i++) await sleep(100);
  });
  return c;
}

/** A voice/camera/stream frame: [0] kind, [1] flags, [2] channels, [4..8) number, [8..12) rate, [12..20) time, then data. */
function frame(kind, flags, seq, size, extra = new Uint8Array(0)) {
  const out = new Uint8Array(20 + extra.length + size);
  const view = new DataView(out.buffer);
  view.setUint8(0, kind);
  view.setUint8(1, flags);
  view.setUint8(2, 1);
  view.setUint32(4, seq, true);
  view.setUint32(8, 48000, true);
  view.setFloat64(12, seq * 20000, true);
  out.set(extra, 20);
  out.fill(7, 20 + extra.length);
  return out;
}

/** The viewer list a host puts after a stream frame's header: [count], then [length][id] for each. */
function viewerList(ids) {
  const enc = ids.map((id) => new TextEncoder().encode(id));
  const out = new Uint8Array(1 + enc.reduce((n, e) => n + 1 + e.length, 0));
  let at = 0;
  out[at++] = enc.length;
  for (const e of enc) {
    out[at++] = e.length;
    out.set(e, at);
    at += e.length;
  }
  return out;
}

const senderOf = (b) => new TextDecoder().decode(b.subarray(1, 1 + b[0]));

const host = client('Host', true);
await host.ready;
const talker = client('Talker', false);
await talker.ready;
const watcher = client('Watcher', false);
await watcher.ready;
check('three people joined', !!host.id && !!talker.id && !!watcher.id);

// ---------------------------------------------------------------- voice and camera
talker.ws.send(frame(1, 1, 0, 80));
await sleep(300);
check('a frame from someone not in voice is not relayed', watcher.binary.length === 0 && host.binary.length === 0);

talker.send({ t: 'voice', on: true });
await sleep(300);
talker.ws.send(frame(2, 1, 1, 100_000));
await sleep(800);
const big = watcher.binary.find((b) => b.length > 100_000);
check('a 100 KB camera key frame reaches someone who never joined voice', !!big, `largest: ${Math.max(0, ...watcher.binary.map((b) => b.length))}`);
if (big) {
  const at = 1 + big[0];
  check('...with the sender in front', senderOf(big) === talker.id);
  check('...and the header and every byte unchanged', big[at] === 2 && (big[at + 1] & 1) === 1 && big.length === at + 20 + 100_000 && big.at(-1) === 7);
}
check('...and it reaches everyone else in the room too', host.binary.some((b) => b.length > 100_000));
check('...but is not sent back to the sender', talker.binary.length === 0);

const before = watcher.binary.length;
for (let burst = 0; burst < 2; burst++) {
  for (let i = 0; i < 150; i++) talker.ws.send(frame(1, 1, burst * 150 + i, 80));
  await sleep(1100);
}
await sleep(400);
check('300 sound frames in two seconds all arrive (chat rate limits do not apply)', watcher.binary.length - before === 300, `got ${watcher.binary.length - before}`);

talker.ws.send(frame(2, 1, 9, 270_000));
await sleep(400);
check('a frame over the size limit is not relayed', !watcher.binary.some((b) => b.length > 260_000));
check('the connection stays open', !talker.closed && !watcher.closed);

// small notes go as room messages: camera on/off to everyone, key-frame requests only to the sender asked
talker.send({ t: 'media', kind: 'cam', ts: 0, on: true });
check('a camera note reaches someone not in voice', !!(await (async () => {
  for (let i = 0; i < 20; i++) {
    if (watcher.json.some((m) => m.t === 'media' && m.kind === 'cam' && m.from === talker.id && m.on === true)) return true;
    await sleep(100);
  }
  return false;
})()));
watcher.send({ t: 'media', kind: 'keyreq', ts: 0, to: talker.id });
await sleep(400);
check('someone watching (not in voice) can ask for a key frame', talker.json.some((m) => m.t === 'media' && m.kind === 'keyreq' && m.from === watcher.id));
check('...and only the sender asked gets it', !host.json.some((m) => m.t === 'media' && m.kind === 'keyreq'));

// ------------------------------------------------------------------- host stream
const streamFrame = (seq, size, ids, flags = 3) => frame(3, flags, seq, size, viewerList(ids));
const streamsAt = (c) => c.binary.filter((b) => b[1 + b[0]] === 3);

host.ws.send(streamFrame(0, 1000, [watcher.id]));
await sleep(300);
check('stream pieces are ignored until the host starts streaming', streamsAt(watcher).length === 0);

host.send({ t: 'streamStart', fileName: 'test.webm', fileSize: 1, source: 'file', position: 0 });
await sleep(300);
talker.ws.send(streamFrame(1, 1000, [watcher.id]));
await sleep(300);
check('only the host can send stream pieces', streamsAt(watcher).length === 0);

host.ws.send(streamFrame(2, 150_000, [watcher.id]));
await sleep(600);
const piece = streamsAt(watcher)[0];
check('a stream piece reaches the viewer it is addressed to', !!piece);
if (piece) {
  check('...with the host in front and the viewer list removed', senderOf(piece) === host.id && piece.length === 1 + piece[0] + 20 + 150_000);
  check('...and its first/last flags and chunk number unchanged', (piece[2 + piece[0]] & 3) === 3 && new DataView(piece.buffer).getUint32(1 + piece[0] + 4, true) === 2);
}
check('...and nobody else', streamsAt(talker).length === 0);

host.ws.send(streamFrame(3, 500, [watcher.id, talker.id]));
await sleep(400);
check('a piece addressed to two viewers reaches both', streamsAt(watcher).length === 2 && streamsAt(talker).length === 1);

host.send({ t: 'chat', text: 'still here' });
await sleep(300);
check('chat still works on the same connections', watcher.json.some((m) => m.t === 'chat' && m.msg?.text === 'still here'));

for (const c of [host, talker, watcher]) c.ws.close();
console.log(failures ? `\n${failures} check(s) failed.` : '\nAll voice and stream relay checks passed.');
process.exit(failures ? 1 : 0);
