import { create } from 'zustand';
import { useToast } from './toast';
import type {
  ChatMsg,
  ClientMsg,
  Member,
  Poll,
  QueueItem,
  RepeatMode,
  ServerMsg,
  StreamInfo,
  SyncState,
} from '@wp/shared';

export type Status = 'idle' | 'connecting' | 'joined' | 'reconnecting' | 'error' | 'kicked';
export type Outgoing = Exclude<ClientMsg, { t: 'join' }>;

interface RoomState {
  status: Status;
  error: string | null;
  errorCode: string | null;
  code: string;
  me: Member | null;
  serverOffset: number;
  members: Member[];
  sync: SyncState;
  stream: StreamInfo;
  queue: QueueItem[];
  history: QueueItem[];
  poll: Poll | null;
  locked: boolean;
  hasPassword: boolean;
  repeat: RepeatMode;
  chat: ChatMsg[];
  typing: Record<string, { nick: string; until: number }>;
}

const blankSync = (): SyncState => ({
  mode: 'idle',
  url: '',
  kind: null,
  videoId: null,
  playing: false,
  position: 0,
  updatedAt: 0,
});

const blankStream = (): StreamInfo => ({
  live: false,
  fileName: '',
  fileSize: 0,
  lastPosition: 0,
  source: 'file',
  epoch: 0,
});

const initial = (): RoomState => ({
  status: 'idle',
  error: null,
  errorCode: null,
  code: '',
  me: null,
  serverOffset: 0,
  members: [],
  sync: blankSync(),
  stream: blankStream(),
  queue: [],
  history: [],
  poll: null,
  locked: false,
  hasPassword: false,
  repeat: 'off',
  chat: [],
  typing: {},
});

export const useRoom = create<RoomState>(() => initial());

// ------------------------------------------------------------------ identity

/** crypto.randomUUID only exists on secure pages (https/localhost); LAN testing over http needs a fallback. */
export function uid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function getSessionId(): string {
  let id = sessionStorage.getItem('wp-session');
  if (!id) {
    id = uid();
    sessionStorage.setItem('wp-session', id);
  }
  return id;
}

export const getNick = (): string => localStorage.getItem('wp-nick') ?? '';
export const setNick = (n: string): void => localStorage.setItem('wp-nick', n);
const hostKey = (code: string) => `wp-host-${code}`;

export const serverNow = (): number => Date.now() + useRoom.getState().serverOffset;

// ----------------------------------------------------------------- event bus

type SignalFn = (from: string, data: any) => void;
type ReactionFn = (emoji: string, nick: string) => void;
type SeekFn = (seconds: number) => void;
const signalFns = new Set<SignalFn>();
const reactionFns = new Set<ReactionFn>();
const seekFns = new Set<SeekFn>();

/** An encoded voice or camera chunk from someone else in voice (see lib/voice.ts). */
type MediaIn = Extract<ServerMsg, { t: 'media' }>;
type MediaFn = (msg: MediaIn) => void;
const mediaFns = new Set<MediaFn>();
export function onMedia(fn: MediaFn): () => void {
  mediaFns.add(fn);
  return () => mediaFns.delete(fn);
}

export function onSignal(fn: SignalFn): () => void {
  signalFns.add(fn);
  return () => signalFns.delete(fn);
}
export function onReaction(fn: ReactionFn): () => void {
  reactionFns.add(fn);
  return () => reactionFns.delete(fn);
}
export function onSeekRequest(fn: SeekFn): () => void {
  seekFns.add(fn);
  return () => seekFns.delete(fn);
}
export function requestSeek(seconds: number): void {
  seekFns.forEach((f) => f(seconds));
}

// --------------------------------------------------------------------- ICE

let icePromise: Promise<RTCIceServer[]> | null = null;
export function getIceServers(): Promise<RTCIceServer[]> {
  icePromise ??= fetch('/api/ice')
    .then((r) => r.json() as Promise<{ iceServers: RTCIceServer[] }>)
    .then((j) => j.iceServers)
    .catch(() => [{ urls: ['stun:stun.l.google.com:19302'] }]);
  return icePromise;
}

// -------------------------------------------------------------- connection

interface JoinOpts {
  code: string;
  nick: string;
  create?: boolean;
  password?: string;
}

let ws: WebSocket | null = null;
let opts: JoinOpts | null = null;
let intentional = false;
let attempts = 0;
let retryTimer: number | undefined;

export async function createRoomCode(): Promise<string> {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error('Could not create a room. Is the server running?');
  return ((await res.json()) as { code: string }).code;
}

export function joinRoom(o: JoinOpts): void {
  if (opts && opts.code === o.code && ws && ws.readyState <= WebSocket.OPEN) {
    opts = { ...opts, ...o, create: opts.create };
    return;
  }
  teardown();
  intentional = false;
  attempts = 0;
  opts = { ...o };
  useRoom.setState({ ...initial(), status: 'connecting', code: o.code });
  void getIceServers();
  open();
}

export function leaveRoom(): void {
  teardown();
  opts = null;
  useRoom.setState(initial());
}

function teardown(): void {
  intentional = true;
  window.clearTimeout(retryTimer);
  if (ws) {
    ws.onclose = null;
    ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

function open(): void {
  if (!opts) return;
  const o = opts;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws/${o.code}`);
  ws = sock;

  sock.onopen = () => {
    sock.send(
      JSON.stringify({
        t: 'join',
        nick: o.nick,
        sessionId: getSessionId(),
        create: o.create || undefined,
        hostToken: localStorage.getItem(hostKey(o.code)) ?? undefined,
        password: o.password,
      }),
    );
  };

  sock.onmessage = (ev) => {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(ev.data as string) as ServerMsg;
    } catch {
      return;
    }
    handle(msg);
  };

  sock.onclose = () => {
    if (intentional || ws !== sock) return;
    const st = useRoom.getState().status;
    if (st === 'error' || st === 'kicked') return;
    if (attempts >= 8) {
      useRoom.setState({ status: 'error', error: 'Connection lost.', errorCode: 'lost' });
      return;
    }
    useRoom.setState({ status: 'reconnecting' });
    attempts += 1;
    retryTimer = window.setTimeout(open, Math.min(1000 * 2 ** (attempts - 1), 8000));
  };
}

function handle(msg: ServerMsg): void {
  const set = useRoom.setState;
  switch (msg.t) {
    case 'welcome': {
      attempts = 0;
      if (opts) {
        opts.create = false;
        if (msg.hostToken) localStorage.setItem(hostKey(opts.code), msg.hostToken);
      }
      const r = msg.room;
      set({
        status: 'joined',
        error: null,
        errorCode: null,
        me: msg.you,
        serverOffset: msg.serverTime - Date.now(),
        code: r.code || useRoom.getState().code,
        members: r.members,
        sync: r.sync,
        stream: r.stream,
        queue: r.queue,
        history: r.history ?? [],
        poll: r.poll,
        locked: r.locked,
        hasPassword: r.hasPassword,
        repeat: r.repeat ?? 'off',
        chat: r.chat,
      });
      return;
    }
    case 'members': {
      const me = msg.members.find((m) => m.id === useRoom.getState().me?.id) ?? useRoom.getState().me;
      set({ members: msg.members, me });
      return;
    }
    case 'sync':
      return set({ sync: msg.sync });
    case 'stream':
      return set({ stream: msg.stream });
    case 'queue':
      return set({ queue: msg.queue, history: msg.history ?? [] });
    case 'poll':
      return set({ poll: msg.poll });
    case 'room':
      return set({ locked: msg.locked, hasPassword: msg.hasPassword, repeat: msg.repeat ?? 'off' });
    case 'chat':
      return set((s) => ({ chat: [...s.chat.slice(-199), msg.msg] }));
    case 'typing':
      return set((s) => ({
        typing: { ...s.typing, [msg.id]: { nick: msg.nick, until: Date.now() + 3000 } },
      }));
    case 'reaction':
      reactionFns.forEach((f) => f(msg.emoji, msg.nick));
      return;
    case 'signal':
      signalFns.forEach((f) => f(msg.from, msg.data));
      return;
    case 'media':
      mediaFns.forEach((f) => f(msg));
      return;
    case 'media':
      mediaFns.forEach((f) => f(msg));
      return;
    case 'kicked':
      intentional = true;
      return set({ status: 'kicked', error: msg.reason, errorCode: 'kicked' });
    case 'error': {
      const fatal = ['not_found', 'exists', 'locked', 'bad_password', 'banned', 'full'];
      if (fatal.includes(msg.code)) {
        intentional = true;
        set({ status: 'error', error: msg.message, errorCode: msg.code });
      } else {
        useToast.getState().show(msg.message); // e.g. a link that cannot be played: say so right away
        set((s) => ({
          chat: [
            ...s.chat,
            { id: uid(), fromId: 'system', nick: 'system', text: msg.message, at: Date.now(), system: true },
          ],
        }));
      }
      return;
    }
  }
}

export function send(msg: Outgoing): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function retryWithPassword(password: string): void {
  if (!opts) return;
  const o = { ...opts, password };
  joinRoomForce(o);
}

function joinRoomForce(o: JoinOpts): void {
  teardown();
  opts = null;
  joinRoom(o);
}
