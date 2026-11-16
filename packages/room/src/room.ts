import {
  ClientMsg,
  LIMITS,
  MEDIA_AUDIO,
  MEDIA_HEADER,
  MEDIA_STREAM,
  MEDIA_VIDEO,
  canControlPlayback,
  filterText,
  parseLink,
  type LinkKind,
  type RepeatMode,
  sortQueue,
  type ChatMsg,
  type Member,
  type Poll,
  type QueueItem,
  type RoomSnapshot,
  type ServerMsg,
  type StreamInfo,
  type SyncState,
} from '@wp/shared';

/** The small slice of the WebSocket API the room needs. Cloudflare sockets and Node `ws` both fit. */
export interface WebSocketLike {
  /** text for room messages, bytes for voice and camera frames */
  send(data: string | Uint8Array): void;
  /** bytes waiting to go out on this connection, when the runtime reports it (Node's ws does) */
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
  addEventListener(type: 'close' | 'error', fn: () => void): void;
}

/** How the host runtime schedules "wipe this room if it is still empty after the grace period". */
export interface RoomHooks {
  setAlarm(afterMs: number): void;
  clearAlarm(): void;
}

interface Conn {
  ws: WebSocketLike;
  member: Member;
  joinedAt: number;
  chatTimes: number[];
  msgTimes: number[];
  lastTyping: number;
  lastReaction: number;
  /** voice and camera frames in the current second (they have their own limit, apart from room messages) */
  mediaWindow: number;
  mediaCount: number;
}

const emptySync = (): SyncState => ({
  mode: 'idle',
  url: '',
  kind: null,
  videoId: null,
  playing: false,
  position: 0,
  updatedAt: Date.now(),
});

const emptyStream = (): StreamInfo => ({
  live: false,
  fileName: '',
  fileSize: 0,
  lastPosition: 0,
  source: 'file',
  epoch: 0,
});

/**
 * One room. All state is in memory: when the room is empty for the grace period the alarm
 * wipes it, and nothing is ever written to disk. Runtime-agnostic: wrapped by a Cloudflare
 * Durable Object (apps/worker) or a plain Node server (apps/server).
 */
export class RoomCore {
  private created = false;
  private code = '';
  private hostToken = '';
  private password = '';
  private locked = false;
  private repeat: RepeatMode = 'off';
  private conns = new Map<string, Conn>();
  /** "receiver|sender" pairs whose video is paused until a key frame, with when the sender was last asked for one */
  private videoHold = new Map<string, number>();
  /** stream viewers who fell behind, with when the host was last told */
  private streamSlow = new Map<string, number>();
  private known = new Set<string>();
  private banned = new Set<string>();
  private sync = emptySync();
  private stream = emptyStream();
  private queue: QueueItem[] = [];
  /** what already played, oldest first (capped at 100) */
  private history: QueueItem[] = [];
  private poll: Poll | null = null;
  private chat: ChatMsg[] = [];

  constructor(private hooks: RoomHooks) {}

  setCode(code: string): void {
    this.code = code;
  }

  /** True when nobody is connected. */
  isEmpty(): boolean {
    return this.conns.size === 0;
  }

  /** False for a code nobody created yet, or a room that was wiped: the host runtime can drop the object. */
  isCreated(): boolean {
    return this.created;
  }

  /** Is this the room's secret host token? (Lets the HTTP layer authorise host-only actions such as uploads.) */
  isHostToken(token: string | undefined | null): boolean {
    return this.created && !!token && token === this.hostToken;
  }

  private reset(): void {
    this.created = false;
    this.hostToken = '';
    this.password = '';
    this.locked = false;
    this.repeat = 'off';
    this.conns.clear();
    this.known.clear();
    this.banned.clear();
    this.sync = emptySync();
    this.stream = emptyStream();
    this.queue = [];
    this.history = [];
    this.poll = null;
    this.chat = [];
  }

  /** The grace-period alarm fired: wipe the room if it is still empty. */
  onAlarm(): void {
    if (this.conns.size === 0) this.reset();
  }

  // ---------------------------------------------------------------- plumbing

  /** Hand a freshly accepted socket to the room. The client's first message must be `join`. */
  attach(ws: WebSocketLike): void {
    let conn: Conn | null = null;
    const joinTimer = setTimeout(() => {
      if (!conn) ws.close(4000, 'join timeout');
    }, 10_000);

    ws.addEventListener('message', (ev: { data: unknown }) => {
      // voice and camera arrive as binary frames: no JSON, and their own size and rate limits
      if (typeof ev.data !== 'string') {
        if (conn) this.onMediaFrame(conn, ev.data);
        return;
      }
      if (ev.data.length > 20_000) return;
      let raw: unknown;
      try {
        raw = JSON.parse(ev.data);
      } catch {
        return;
      }
      const parsed = ClientMsg.safeParse(raw);
      if (!parsed.success) {
        this.sendTo(ws, { t: 'error', code: 'bad_message', message: 'Invalid message.' });
        return;
      }
      const msg = parsed.data;
      if (!conn) {
        if (msg.t === 'join') {
          conn = this.onJoin(ws, msg);
          if (conn) clearTimeout(joinTimer);
        }
        return;
      }
      if (!this.rateOk(conn)) return;
      this.onMessage(conn, msg);
    });

    const onClose = () => {
      clearTimeout(joinTimer);
      if (conn) this.onLeave(conn);
    };
    ws.addEventListener('close', onClose);
    ws.addEventListener('error', onClose);
  }

  /**
   * One encoded piece of someone's voice or camera. It is passed on unchanged to the other people in voice, with the
   * sender's id in front. Nothing is decoded here.
   */
  private onMediaFrame(c: Conn, data: unknown): void {
    const frame = data instanceof Uint8Array ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!frame || frame.length < MEDIA_HEADER || frame.length > LIMITS.mediaFrame) return;
    const kind = frame[0];
    if (kind !== MEDIA_AUDIO && kind !== MEDIA_VIDEO && kind !== MEDIA_STREAM) return;
    const now = Date.now();
    if (now - c.mediaWindow >= 1000) {
      c.mediaWindow = now;
      c.mediaCount = 0;
    }
    if (++c.mediaCount > LIMITS.mediaFramesPerSec) return;
    if (kind === MEDIA_STREAM) return this.onStreamPiece(c, frame, now);
    if (!c.member.voice) return;

    const id = new TextEncoder().encode(c.member.id);
    const out = new Uint8Array(1 + id.length + frame.length);
    out[0] = id.length;
    out.set(id, 1);
    out.set(frame, 1 + id.length);
    const key = (frame[1]! & 1) === 1;

    for (const x of this.conns.values()) {
      // everyone in the room receives it, in voice or not: watching and listening need no Join voice
      if (x === c) continue;
      if (kind === MEDIA_VIDEO) {
        // A receiver whose connection is backed up misses video, not sound. Frames after a skipped one depend on
        // it, so nothing more goes to them until a key frame; the sender is asked for one once they have caught up.
        const pair = `${x.member.id}|${c.member.id}`;
        const holding = this.videoHold.has(pair);
        const backed = (x.ws.bufferedAmount ?? 0) > LIMITS.mediaBacklog;
        if (backed || (holding && !key)) {
          const asked = this.videoHold.get(pair) ?? 0;
          if (!holding) this.videoHold.set(pair, 0);
          if (!backed && now - asked > 1000) {
            this.videoHold.set(pair, now);
            this.send(c, { t: 'media', from: x.member.id, kind: 'keyreq', ts: 0 });
          }
          continue;
        }
        if (holding) this.videoHold.delete(pair);
      }
      try {
        x.ws.send(out);
      } catch {
        /* socket already closing */
      }
    }
  }

  /**
   * A piece of the host's own stream, addressed to the viewers who are ready for it. Each listed viewer gets it
   * unchanged (with the host's id in front and the address list removed). A viewer whose connection is backed up is
   * skipped, and the host is told, so it starts a fresh recording they can pick up from.
   */
  private onStreamPiece(c: Conn, frame: Uint8Array, now: number): void {
    if (c.member.role !== 'host' || this.sync.mode !== 'stream') return;
    let at = MEDIA_HEADER;
    const count = frame[at++] ?? 0;
    const targets: string[] = [];
    const text = new TextDecoder();
    for (let i = 0; i < count; i++) {
      const len = frame[at++] ?? 0;
      if (at + len > frame.length) return;
      targets.push(text.decode(frame.subarray(at, at + len)));
      at += len;
    }
    const id = new TextEncoder().encode(c.member.id);
    const out = new Uint8Array(1 + id.length + MEDIA_HEADER + (frame.length - at));
    out[0] = id.length;
    out.set(id, 1);
    out.set(frame.subarray(0, MEDIA_HEADER), 1 + id.length);
    out.set(frame.subarray(at), 1 + id.length + MEDIA_HEADER);
    for (const t of targets) {
      const x = this.conns.get(t);
      if (!x || x === c) continue;
      if ((x.ws.bufferedAmount ?? 0) > LIMITS.streamBacklog) {
        // at most one report every 2 s per viewer, while they stay behind
        if (now - (this.streamSlow.get(t) ?? 0) > 2000) {
          this.streamSlow.set(t, now);
          this.send(c, { t: 'signal', from: t, data: { kind: 'stream-slow' } });
        }
        continue;
      }
      try {
        x.ws.send(out);
      } catch {
        /* socket already closing */
      }
    }
  }

  private rateOk(c: Conn): boolean {
    const now = Date.now();
    c.msgTimes = c.msgTimes.filter((t) => now - t < 10_000);
    if (c.msgTimes.length >= 300) return false;
    c.msgTimes.push(now);
    return true;
  }

  private sendTo(ws: WebSocketLike, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* socket already closing */
    }
  }

  private send(c: Conn | undefined, msg: ServerMsg): void {
    if (c) this.sendTo(c.ws, msg);
  }

  private broadcast(msg: ServerMsg, except?: string): void {
    const text = JSON.stringify(msg);
    for (const [id, c] of this.conns) {
      if (id === except) continue;
      try {
        c.ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  private members(): Member[] {
    return [...this.conns.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((c) => ({ ...c.member }));
  }

  private snapshot(): RoomSnapshot {
    return {
      code: this.code,
      members: this.members(),
      sync: this.sync,
      stream: this.stream,
      queue: sortQueue(this.queue),
      history: this.history,
      poll: this.poll,
      locked: this.locked,
      hasPassword: this.password !== '',
      repeat: this.repeat,
      chat: this.chat,
    };
  }

  /** Host and organizers: moderation, polls and room settings. */
  private canControl(c: Conn): boolean {
    return c.member.role === 'host' || c.member.role === 'mod';
  }

  /** Playback and the queue: organizers always, everyone in a small room (see canControlPlayback). */
  private canPlay(c: Conn): boolean {
    return canControlPlayback(c.member.role, this.conns.size);
  }

  private broadcastMembers(): void {
    this.broadcast({ t: 'members', members: this.members() });
  }

  private systemChat(text: string, only?: Conn[]): void {
    const msg: ChatMsg = { id: crypto.randomUUID(), fromId: 'system', nick: 'system', text, at: Date.now(), system: true };
    if (only) {
      for (const c of only) this.send(c, { t: 'chat', msg });
      return;
    }
    this.pushChat(msg);
    this.broadcast({ t: 'chat', msg });
  }

  private pushChat(msg: ChatMsg): void {
    this.chat.push(msg);
    if (this.chat.length > LIMITS.chatHistory) this.chat.shift();
  }

  private setSync(patch: Partial<SyncState>): void {
    this.sync = { ...this.sync, ...patch, updatedAt: Date.now() };
    this.broadcast({ t: 'sync', sync: this.sync });
  }

  private setStream(patch: Partial<StreamInfo>): void {
    this.stream = { ...this.stream, ...patch };
    this.broadcast({ t: 'stream', stream: this.stream });
  }

  private broadcastQueue(): void {
    this.broadcast({ t: 'queue', queue: sortQueue(this.queue), history: this.history });
  }

  private hostConn(): Conn | undefined {
    for (const c of this.conns.values()) if (c.member.role === 'host') return c;
    return undefined;
  }

  // -------------------------------------------------------------------- join

  private onJoin(ws: WebSocketLike, msg: Extract<ClientMsg, { t: 'join' }>): Conn | null {
    const fail = (code: string, message: string): null => {
      this.sendTo(ws, { t: 'error', code, message });
      try {
        ws.close(4004, code);
      } catch {
        /* ignore */
      }
      return null;
    };

    const id = msg.sessionId;
    let createdNow = false;

    if (!this.created) {
      if (!msg.create) return fail('not_found', 'That room does not exist (or has closed).');
      this.created = true;
      this.hostToken = crypto.randomUUID().replace(/-/g, '');
      createdNow = true;
    } else if (msg.create) {
      return fail('exists', 'Room code already in use, try again.');
    }

    if (this.banned.has(id)) return fail('banned', 'You were removed from this room.');

    const isHostToken = !createdNow && !!msg.hostToken && msg.hostToken === this.hostToken;
    const isHost = createdNow || isHostToken;
    const wasKnown = this.known.has(id);

    if (!isHost && !wasKnown) {
      if (this.locked) return fail('locked', 'This room is locked.');
      if (this.password && msg.password !== this.password) return fail('bad_password', 'Wrong room password.');
    }
    if (this.conns.size >= LIMITS.maxMembers && !this.conns.has(id)) return fail('full', 'Room is full.');

    // replace a stale socket for the same session
    const old = this.conns.get(id);
    if (old) {
      this.conns.delete(id);
      try {
        old.ws.close(4001, 'replaced');
      } catch {
        /* ignore */
      }
    }

    if (isHost) {
      // demote whoever is acting as host right now
      const current = this.hostConn();
      if (current && current.member.id !== id) current.member.role = 'mod';
    }

    const nick = filterText(msg.nick).slice(0, 24);
    const conn: Conn = {
      ws,
      member: {
        id,
        nick,
        role: isHost ? 'host' : old?.member.role === 'mod' ? 'mod' : 'viewer',
        muted: old?.member.muted ?? false,
        voice: false,
      },
      joinedAt: old?.joinedAt ?? Date.now(),
      chatTimes: [],
      msgTimes: [],
      lastTyping: 0,
      lastReaction: 0,
      mediaWindow: 0,
      mediaCount: 0,
    };
    this.conns.set(id, conn);
    this.known.add(id);
    this.hooks.clearAlarm();

    this.sendTo(ws, {
      t: 'welcome',
      you: { ...conn.member },
      hostToken: createdNow ? this.hostToken : undefined,
      serverTime: Date.now(),
      room: this.snapshot(),
    });
    this.broadcastMembers();
    if (!old) this.systemChat(`${nick} joined`);
    if (isHost && !createdNow && this.sync.mode === 'stream' && !this.stream.live) {
      this.systemChat('Host is back. They can resume the stream.');
    }
    return conn;
  }

  private onLeave(c: Conn): void {
    if (this.conns.get(c.member.id) !== c) return; // already replaced
    this.conns.delete(c.member.id);
    this.systemChat(`${c.member.nick} left`);

    if (c.member.role === 'host') {
      if (this.sync.mode === 'stream') {
        // nobody else owns the file: room stays, stream waits for the host
        if (this.stream.live) {
          this.setStream({ live: false });
          this.systemChat('Host disconnected. Waiting for them to return…');
        }
      } else {
        // link rooms do not need the host: pass the controls to the longest-present member
        const next = [...this.conns.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (next) {
          next.member.role = 'host';
          this.systemChat(`${next.member.nick} is now the host`);
        }
      }
    }
    this.broadcastMembers();

    if (this.conns.size === 0) {
      const grace = this.sync.mode === 'stream' ? LIMITS.graceStreamMs : LIMITS.graceLinkMs;
      this.hooks.setAlarm(grace);
    }
  }

  // ---------------------------------------------------------------- messages

  private onMessage(c: Conn, msg: ClientMsg): void {
    const isHost = c.member.role === 'host';
    const control = this.canPlay(c);
    const organiser = this.canControl(c);

    switch (msg.t) {
      case 'join':
        return;

      case 'chat': {
        if (c.member.muted) return this.send(c, { t: 'error', code: 'muted', message: 'You are muted.' });
        const now = Date.now();
        c.chatTimes = c.chatTimes.filter((t) => now - t < 5000);
        if (c.chatTimes.length >= 5) return this.send(c, { t: 'error', code: 'rate', message: 'Slow down a little.' });
        c.chatTimes.push(now);
        const out: ChatMsg = {
          id: crypto.randomUUID(),
          fromId: c.member.id,
          nick: c.member.nick,
          text: filterText(msg.text),
          at: now,
        };
        this.pushChat(out);
        this.broadcast({ t: 'chat', msg: out });
        return;
      }

      case 'typing': {
        const now = Date.now();
        if (now - c.lastTyping < 2000) return;
        c.lastTyping = now;
        this.broadcast({ t: 'typing', id: c.member.id, nick: c.member.nick }, c.member.id);
        return;
      }

      case 'reaction': {
        const now = Date.now();
        if (now - c.lastReaction < 150) return;
        c.lastReaction = now;
        this.broadcast({ t: 'reaction', id: c.member.id, nick: c.member.nick, emoji: msg.emoji });
        return;
      }

      // ------------------------------------------------------------ playback
      case 'load': {
        if (!control) return;
        const p = parseLink(msg.url);
        if (!p.ok) return this.send(c, { t: 'error', code: 'bad_link', message: p.error });
        this.loadLink(p.kind, p.url, p.videoId, msg.title);
        return;
      }

      case 'control': {
        // link mode: anyone who can play (see canPlay). stream mode: only the host, to tell viewers "host paused / resumed"
        const allowed = this.sync.mode === 'link' ? control : this.sync.mode === 'stream' && isHost;
        if (!allowed || (this.sync.mode === 'stream' && msg.action === 'seek')) return;
        if (msg.action === 'play') this.setSync({ playing: true, position: msg.position });
        else if (msg.action === 'pause') this.setSync({ playing: false, position: msg.position });
        else this.setSync({ position: msg.position });
        return;
      }

      case 'ended': {
        if (!control || this.sync.mode !== 'link') return;
        this.advanceQueue(msg.position);
        return;
      }

      // --------------------------------------------------------------- queue
      case 'queueAdd':
      case 'queueAddMany': {
        const items = msg.t === 'queueAdd' ? [{ url: msg.url, title: msg.title }] : msg.items;
        let added = 0;
        let firstError: { code: string; message: string } | null = null;
        for (const it of items) {
          const err = this.enqueue(c, it.url, it.title, control);
          if (!err) added++;
          else {
            firstError ??= err;
            if (err.code === 'queue_full') break;
          }
        }
        if (!added) return firstError ? this.send(c, { t: 'error', ...firstError }) : undefined;
        this.broadcastQueue();
        if (!control) {
          const what = added === 1 ? 'a video' : `${added} videos`;
          const mods = [...this.conns.values()].filter((x) => this.canControl(x));
          this.systemChat(`${c.member.nick} suggested ${what}. Open the Queue tab to approve or reject.`, mods);
          this.send(c, { t: 'chat', msg: sysMsg(`Suggested ${what}. The host decides what plays.`) });
        }
        if (firstError?.code === 'queue_full') this.send(c, { t: 'error', ...firstError });
        return;
      }

      case 'queueApprove': {
        if (!control) return;
        const item = this.queue.find((q) => q.id === msg.id);
        if (!item) return;
        item.approved = true;
        this.broadcastQueue();
        return;
      }

      case 'queueVote': {
        const item = this.queue.find((q) => q.id === msg.id);
        if (!item) return;
        const i = item.votes.indexOf(c.member.id);
        if (i >= 0) item.votes.splice(i, 1);
        else item.votes.push(c.member.id);
        this.broadcastQueue();
        return;
      }

      case 'queueRemove': {
        const item = this.queue.find((q) => q.id === msg.id);
        if (!item || !(control || item.byId === c.member.id)) return;
        this.queue = this.queue.filter((q) => q.id !== msg.id);
        this.broadcastQueue();
        return;
      }

      case 'queuePlay': {
        if (!control) return;
        const item = this.queue.find((q) => q.id === msg.id);
        if (!item) return;
        this.queue = this.queue.filter((q) => q.id !== msg.id);
        this.broadcastQueue();
        this.loadLink(item.kind, item.url, item.videoId, item.title);
        return;
      }

      case 'queueNext': {
        if (!control) return;
        this.advanceQueue();
        return;
      }

      // like a music player: "previous" plays the last played video, and what was playing goes back to the
      // top of Up next, so "next" returns to it
      case 'queuePrev': {
        if (!control) return;
        const prev = this.history.pop();
        if (!prev) return;
        const cur = this.nowItem();
        if (cur) this.queue.unshift({ ...cur, by: c.member.nick, byId: c.member.id });
        this.broadcastQueue();
        this.loadLink(prev.kind, prev.url, prev.videoId, prev.title, false);
        return;
      }

      // empties Up next (pending suggestions stay for the host to decide on)
      case 'queueClear': {
        if (!control) return;
        this.queue = this.queue.filter((q) => !q.approved);
        this.broadcastQueue();
        return;
      }

      case 'historyPlay': {
        if (!control) return;
        const item = this.history.find((q) => q.id === msg.id);
        if (!item) return;
        this.history = this.history.filter((q) => q.id !== msg.id);
        this.loadLink(item.kind, item.url, item.videoId, item.title);
        this.broadcastQueue();
        return;
      }

      // ----------------------------------------------------------- moderation
      case 'setRole': {
        if (!isHost) return;
        const t = this.conns.get(msg.id);
        if (!t || t.member.role === 'host') return;
        t.member.role = msg.role;
        this.broadcastMembers();
        return;
      }

      case 'kick': {
        if (!organiser) return;
        const t = this.conns.get(msg.id);
        if (!t || t === c || t.member.role === 'host') return;
        if (t.member.role === 'mod' && !isHost) return;
        this.banned.add(t.member.id);
        this.send(t, { t: 'kicked', reason: 'You were removed by the host or an organizer.' });
        try {
          t.ws.close(4003, 'kicked');
        } catch {
          /* ignore */
        }
        this.onLeave(t);
        return;
      }

      case 'mute': {
        if (!organiser) return;
        const t = this.conns.get(msg.id);
        if (!t || t.member.role !== 'viewer') return;
        t.member.muted = msg.muted;
        this.broadcastMembers();
        return;
      }

      case 'roomSettings': {
        if (!organiser) return;
        if (msg.repeat !== undefined) this.repeat = msg.repeat; // host and mods
        if (isHost) {
          if (msg.locked !== undefined) this.locked = msg.locked;
          if (msg.password !== undefined) this.password = msg.password ?? '';
        }
        this.broadcast({ t: 'room', locked: this.locked, hasPassword: this.password !== '', repeat: this.repeat });
        return;
      }

      case 'queueShuffle': {
        if (!control) return;
        // Fisher-Yates; a shuffle is a fresh random order, so votes no longer apply
        for (let i = this.queue.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
        }
        for (const q of this.queue) q.votes = [];
        this.broadcastQueue();
        return;
      }

      case 'report': {
        const t = this.conns.get(msg.id);
        if (!t) return;
        const mods = [...this.conns.values()].filter((x) => this.canControl(x));
        this.systemChat(`${c.member.nick} reported ${t.member.nick}: ${msg.reason || 'no reason given'}`, mods);
        this.send(c, { t: 'chat', msg: sysMsg('Report sent to the host and organizers.') });
        return;
      }

      // --------------------------------------------------------------- stream
      case 'streamStart': {
        if (!isHost) return;
        this.setSync({ mode: 'stream', url: '', kind: null, videoId: null, playing: true, position: 0 });
        this.setStream({
          live: true,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          source: msg.source,
          lastPosition: msg.position,
          epoch: this.stream.epoch + 1,
        });
        this.systemChat('Host started streaming');
        return;
      }

      case 'streamStop': {
        if (!isHost) return;
        this.setStream({ ...emptyStream(), epoch: this.stream.epoch });
        this.setSync({ mode: 'idle', url: '', kind: null, videoId: null, playing: false, position: 0 });
        this.systemChat('Host stopped the stream');
        return;
      }

      case 'streamPosition': {
        if (!isHost || this.sync.mode !== 'stream') return;
        this.stream.lastPosition = msg.position; // stored quietly, no broadcast
        return;
      }

      // ------------------------------------------------------------ voice relay
      case 'media': {
        // Everyone in the room can watch and hear the people in voice; only people in voice send.
        if (msg.kind === 'keyreq') {
          // a viewer's decoder lost its place, or they just started watching: only that sender needs to hear it
          const target = msg.to ? this.conns.get(msg.to) : undefined;
          if (target && target !== c && target.member.voice) this.send(target, { t: 'media', from: c.member.id, kind: 'keyreq', ts: 0 });
          return;
        }
        // camera on / off: a small note to everyone else (sound and pictures go as binary frames, see onMediaFrame)
        if (msg.kind !== 'cam' || !c.member.voice) return;
        for (const x of this.conns.values()) {
          if (x !== c) this.send(x, { t: 'media', from: c.member.id, kind: 'cam', ts: 0, on: msg.on });
        }
        return;
      }

      // ------------------------------------------------------------ signalling
      case 'signal': {
        const target = this.conns.get(msg.to);
        if (!target) return;
        if (JSON.stringify(msg.data ?? null).length > 16_000) return;
        this.send(target, { t: 'signal', from: c.member.id, data: msg.data });
        return;
      }

      case 'voice': {
        if (msg.on) {
          const count = [...this.conns.values()].filter((x) => x.member.voice).length;
          if (!c.member.voice && count >= LIMITS.maxVoice) {
            return this.send(c, { t: 'error', code: 'voice_full', message: 'Voice channel is full.' });
          }
        }
        c.member.voice = msg.on;
        this.broadcastMembers();
        return;
      }

      // ---------------------------------------------------------------- polls
      case 'pollCreate': {
        if (!organiser) return;
        this.poll = { id: crypto.randomUUID(), question: msg.question, options: msg.options, votes: {}, open: true };
        this.broadcast({ t: 'poll', poll: this.poll });
        return;
      }

      case 'pollVote': {
        if (!this.poll || !this.poll.open || msg.index >= this.poll.options.length) return;
        this.poll.votes[c.member.id] = msg.index;
        this.broadcast({ t: 'poll', poll: this.poll });
        return;
      }

      case 'pollClose': {
        if (!organiser || !this.poll) return;
        this.poll.open = false;
        this.broadcast({ t: 'poll', poll: this.poll });
        return;
      }
    }
  }

  /**
   * Start a video for everyone. What was playing moves to "Played" (unless `toHistory` is false), except
   * when the new link is the yt-dlp copy (…?yt=<id>) of that same YouTube video: that is the same song.
   */
  private loadLink(kind: LinkKind, url: string, videoId: string | null, title?: string, toHistory = true): void {
    const copyOf = /[?&]yt=([\w-]{11})/.exec(url)?.[1] ?? null;
    const srcOf = sourceOf(url);
    const sameSong = (copyOf !== null && copyOf === this.sync.videoId) || (srcOf !== null && srcOf === this.sync.url);
    if (sameSong) title ??= this.sync.title;
    else if (toHistory && this.remember()) this.broadcastQueue();
    if (this.sync.mode === 'stream') {
      this.setStream({ ...emptyStream(), epoch: this.stream.epoch });
    }
    // a copy keeps its YouTube id, so "Played" and the suggestions still know which video it is
    this.setSync({ mode: 'link', url, kind, videoId: videoId ?? copyOf, playing: true, position: 0, title });
  }

  /** What is playing now, as a queue entry. A yt-dlp copy becomes its YouTube link again (copies expire). */
  private nowItem(): QueueItem | null {
    const s = this.sync;
    if (s.mode !== 'link' || !s.url || !s.kind) return null;
    const src = s.kind === 'hls' ? sourceOf(s.url) : null;
    const base =
      s.kind === 'hls' && s.videoId
        ? { url: `https://www.youtube.com/watch?v=${s.videoId}`, kind: 'youtube' as const }
        : src
          ? { url: src, kind: 'site' as const }
          : { url: s.url, kind: s.kind };
    return { id: crypto.randomUUID(), ...base, videoId: s.videoId, ...(s.title ? { title: s.title } : {}), by: 'played', byId: 'system', votes: [], approved: true };
  }

  /** Add what is playing to "Played". Returns whether the list changed. */
  private remember(): boolean {
    const item = this.nowItem();
    if (!item || this.history[this.history.length - 1]?.url === item.url) return false;
    this.history.push(item);
    if (this.history.length > 100) this.history.shift();
    return true;
  }

  /**
   * One link from a member into the queue. Host/mods add straight to "up next", everyone else suggests.
   * In an empty, idle room the host's first link just starts playing. Returns an error, or null when done.
   */
  private enqueue(c: Conn, url: string, title: string | undefined, control: boolean): { code: string; message: string } | null {
    const p = parseLink(url);
    if (!p.ok) return { code: 'bad_link', message: p.error };
    if (this.queue.length >= LIMITS.queueMax) return { code: 'queue_full', message: 'The queue is full.' };
    if (control && this.sync.mode === 'idle' && this.queue.length === 0) {
      this.loadLink(p.kind, p.url, p.videoId, title);
      return null;
    }
    this.queue.push({
      id: crypto.randomUUID(),
      url: p.url,
      kind: p.kind,
      videoId: p.videoId,
      ...(title ? { title } : {}),
      by: c.member.nick,
      byId: c.member.id,
      votes: [],
      approved: control,
    });
    return null;
  }

  /** `endedAt` is where the finished video stopped, so everyone rests on the last frame instead of jumping back to 0. */
  private advanceQueue(endedAt?: number): void {
    const cur = this.sync;
    const playing = cur.mode === 'link' && cur.kind && cur.url;
    if (this.repeat === 'one' && playing) {
      this.loadLink(cur.kind!, cur.url, cur.videoId, cur.title, false); // play the same video again from the start
      return;
    }
    if (this.repeat === 'all' && playing) {
      // the finished video goes to the back of the queue, so the whole list loops
      const again = this.nowItem();
      if (again) this.queue.push({ ...again, by: 'repeat' });
      this.broadcastQueue();
    }
    const next = sortQueue(this.queue.filter((q) => q.approved))[0]; // suggestions never auto-play
    if (!next) {
      // a site link that could not be fetched never played: go back to "nothing playing" instead of leaving
      // everyone on "Getting this video ready…"
      if (cur.kind === 'site') return this.setSync(emptySync());
      this.setSync(endedAt !== undefined && endedAt > 0 ? { playing: false, position: endedAt } : { playing: false });
      return;
    }
    this.queue = this.queue.filter((q) => q.id !== next.id);
    this.broadcastQueue();
    this.loadLink(next.kind, next.url, next.videoId, next.title);
  }
}

/** the page a yt-dlp copy of a site link came from (its ?src=), if any */
function sourceOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get('src');
  } catch {
    return null;
  }
}

function sysMsg(text: string): ChatMsg {
  return { id: crypto.randomUUID(), fromId: 'system', nick: 'system', text, at: Date.now(), system: true };
}
