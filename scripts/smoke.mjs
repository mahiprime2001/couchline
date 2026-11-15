// End-to-end smoke test against a running worker: `pnpm dev` (or wrangler dev) first.
//   node scripts/smoke.mjs [http://localhost:8787]
// Uses Node's built-in WebSocket. Exits non-zero on the first failed check.

const BASE = process.argv[2] ?? 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');
let failures = 0;

const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(code, label) {
  const ws = new WebSocket(`${WS}/ws/${code}`);
  const inbox = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(e.data));
  const c = {
    ws,
    inbox,
    id: crypto.randomUUID(),
    open: new Promise((res) => (ws.onopen = res)),
    send: (m) => ws.send(JSON.stringify(m)),
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const hit = inbox.find(pred);
        if (hit) return hit;
        await sleep(25);
      }
      return null;
    },
    async join(extra = {}) {
      await c.open;
      c.send({ t: 'join', nick: label, sessionId: c.id, ...extra });
      return c.waitFor((m) => m.t === 'welcome' || m.t === 'error');
    },
  };
  return c;
}

const res = await fetch(`${BASE}/api/rooms`, { method: 'POST' });
const { code } = await res.json();
check('create room code', /^[A-Z0-9]{6}$/.test(code), code);

const ice = await (await fetch(`${BASE}/api/ice`)).json();
check('ice servers endpoint', Array.isArray(ice.iceServers) && ice.iceServers.length > 0);

// host + viewer join
const host = client(code, 'Host');
const w1 = await host.join({ create: true });
check('host welcome with token', w1?.t === 'welcome' && !!w1.hostToken && w1.you.role === 'host');

const viewer = client(code, 'Viewer');
const w2 = await viewer.join();
check('viewer joins as viewer', w2?.t === 'welcome' && w2.you.role === 'viewer');
check('host sees 2 members', !!(await host.waitFor((m) => m.t === 'members' && m.members.length === 2)));

// missing room
const ghost = client('ZZZZZZ', 'Ghost');
const w3 = await ghost.join();
check('unknown room is rejected', w3?.t === 'error' && w3.code === 'not_found');

// playback rules
host.send({ t: 'load', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
const s1 = await viewer.waitFor((m) => m.t === 'sync' && m.sync.mode === 'link');
check('host load syncs viewer', s1?.sync.videoId === 'dQw4w9WgXcQ' && s1.sync.playing);

host.send({ t: 'load', url: 'https://evil.example/x' });
check('bad link rejected', !!(await host.waitFor((m) => m.t === 'error' && m.code === 'bad_link')));

viewer.send({ t: 'control', action: 'seek', position: 999 });
await sleep(300);
check('viewer cannot control playback', !viewer.inbox.some((m) => m.t === 'sync' && m.sync.position === 999) && !host.inbox.some((m) => m.t === 'sync' && m.sync.position === 999));

host.send({ t: 'control', action: 'pause', position: 42 });
const s2 = await viewer.waitFor((m) => m.t === 'sync' && !m.sync.playing && m.sync.position === 42);
check('host pause syncs', !!s2);

// chat
viewer.send({ t: 'chat', text: 'hello 12:34' });
check('chat relayed to host', !!(await host.waitFor((m) => m.t === 'chat' && m.msg.text === 'hello 12:34')));

// queue + vote
viewer.send({ t: 'queueAdd', url: 'https://youtu.be/9bZkp7q19f0' });
const q1 = await host.waitFor((m) => m.t === 'queue' && m.queue.length === 1);
check('queue add', !!q1);
viewer.send({ t: 'queueVote', id: q1.queue[0].id });
check('queue vote', !!(await host.waitFor((m) => m.t === 'queue' && m.queue[0]?.votes.length === 1)));

// suggestions need the host's approval before they can ever auto-play
check('viewer suggestion starts pending', q1.queue[0].approved === false);
const itemId = q1.queue[0].id;
viewer.send({ t: 'queueApprove', id: itemId });
await sleep(300);
check('a viewer cannot approve', !host.inbox.some((m) => m.t === 'queue' && m.queue.some((q) => q.approved)));
host.send({ t: 'ended', position: 42 });
await sleep(400);
check('pending suggestion does not auto-play when the video ends', !host.inbox.some((m) => m.t === 'sync' && m.sync.videoId === '9bZkp7q19f0'));
host.send({ t: 'queueApprove', id: itemId });
check('host can approve', !!(await host.waitFor((m) => m.t === 'queue' && m.queue[0]?.approved === true)));
host.send({ t: 'ended', position: 42 });
const adv = await viewer.waitFor((m) => m.t === 'sync' && m.sync.videoId === '9bZkp7q19f0' && m.sync.playing);
check('approved item auto-plays when the video ends', !!adv);

// repeat (off / all / one) and shuffle: Musike-style queue tools
viewer.send({ t: 'roomSettings', repeat: 'all' });
await sleep(250);
check('a viewer cannot change repeat', !host.inbox.some((m) => m.t === 'room' && m.repeat === 'all'));
host.send({ t: 'roomSettings', repeat: 'one' });
check('host can set repeat', !!(await viewer.waitFor((m) => m.t === 'room' && m.repeat === 'one')));
const markRepeat = viewer.inbox.length;
host.send({ t: 'ended', position: 30 });
await sleep(400);
check('repeat "one" replays the same video from the start when it ends', viewer.inbox.slice(markRepeat).some((m) => m.t === 'sync' && m.sync.videoId === '9bZkp7q19f0' && m.sync.playing && m.sync.position === 0));
host.send({ t: 'roomSettings', repeat: 'off' });
for (const id of ['dQw4w9WgXcQ', 'M7lc1UVf-VE', 'kJQP7kiw5Fk']) host.send({ t: 'queueAdd', url: `https://youtu.be/${id}` });
const q3 = await host.waitFor((m) => m.t === 'queue' && m.queue.length >= 3);
const markViewerShuffle = host.inbox.length;
viewer.send({ t: 'queueShuffle' });
await sleep(250);
check('a viewer cannot shuffle the queue', !host.inbox.slice(markViewerShuffle).some((m) => m.t === 'queue'));
const markShuffle = host.inbox.length;
host.send({ t: 'queueShuffle' });
await sleep(300);
const shuffled = host.inbox.slice(markShuffle).find((m) => m.t === 'queue');
check('host shuffle keeps the same videos and clears votes', !!shuffled && shuffled.queue.length === q3.queue.length && shuffled.queue.map((x) => x.id).sort().join() === q3.queue.map((x) => x.id).sort().join() && shuffled.queue.every((x) => x.votes.length === 0), JSON.stringify(shuffled?.queue.length));

// poll
host.send({ t: 'pollCreate', question: 'Skip?', options: ['Yes', 'No'] });
await viewer.waitFor((m) => m.t === 'poll' && m.poll?.open);
viewer.send({ t: 'pollVote', index: 1 });
check('poll vote', !!(await host.waitFor((m) => m.t === 'poll' && Object.values(m.poll.votes).includes(1))));

// signalling relay
viewer.send({ t: 'signal', to: host.id, data: { kind: 'stream-request' } });
const sig = await host.waitFor((m) => m.t === 'signal');
check('signal relayed', sig?.from === viewer.id && sig.data.kind === 'stream-request');

// stream mode: host leaves, room survives, host returns
host.send({ t: 'streamStart', fileName: 'movie.mp4', fileSize: 123, source: 'file', position: 0 });
check('stream start', !!(await viewer.waitFor((m) => m.t === 'stream' && m.stream.live)));
host.send({ t: 'control', action: 'pause', position: 5 });
check('host pause is relayed in stream mode', !!(await viewer.waitFor((m) => m.t === 'sync' && m.sync.mode === 'stream' && m.sync.playing === false)));
viewer.send({ t: 'control', action: 'play', position: 1 });
await sleep(250);
check('a viewer cannot flip stream playback', !viewer.inbox.some((m) => m.t === 'sync' && m.sync.mode === 'stream' && m.sync.position === 1));
host.send({ t: 'control', action: 'play', position: 6 });
check('host resume is relayed in stream mode', !!(await viewer.waitFor((m) => m.t === 'sync' && m.sync.mode === 'stream' && m.sync.playing === true && m.sync.position === 6)));
host.send({ t: 'streamPosition', position: 1932 });
await sleep(100);
host.ws.close();
const away = await viewer.waitFor((m) => m.t === 'stream' && m.stream.live === false);
check('host leaving marks stream away (no handoff)', !!away);
const sAfter = viewer.inbox.filter((m) => m.t === 'members').pop();
check('nobody inherits host in stream mode', sAfter && !sAfter.members.some((x) => x.role === 'host'));

const host2 = client(code, 'Host');
host2.id = host.id;
const w4 = await host2.join({ hostToken: w1.hostToken });
check('host reclaims with token', w4?.t === 'welcome' && w4.you.role === 'host');
check('resume info kept (file name + last position)', w4.room.stream.fileName === 'movie.mp4' && w4.room.stream.lastPosition === 1932);

// moderation
host2.send({ t: 'mute', id: viewer.id, muted: true });
await sleep(150);
viewer.send({ t: 'chat', text: 'should not arrive' });
await sleep(250);
check('muted viewer cannot chat', !host2.inbox.some((m) => m.t === 'chat' && m.msg.text === 'should not arrive'));

host2.send({ t: 'roomSettings', password: 'pw123' });
await sleep(100);
const late = client(code, 'Late');
const w5 = await late.join();
check('password required', w5?.t === 'error' && w5.code === 'bad_password');
const late2 = client(code, 'Late2');
const w6 = await late2.join({ password: 'pw123' });
check('password accepted', w6?.t === 'welcome');

host2.send({ t: 'kick', id: late2.id });
check('kick works', !!(await late2.waitFor((m) => m.t === 'kicked')));

// link-mode host handoff
const code2 = (await (await fetch(`${BASE}/api/rooms`, { method: 'POST' })).json()).code;
const a = client(code2, 'A');
await a.join({ create: true });
const b = client(code2, 'B');
await b.join();
a.ws.close();
const promoted = await b.waitFor((m) => m.t === 'members' && m.members.find((x) => x.id === b.id)?.role === 'host');
check('link room hands host to next member', !!promoted);

for (const c of [host2, viewer, b, late, late2, ghost]) try { c.ws.close(); } catch {}
console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
