/**
 * Host side of host-stream mode.
 *
 *   MediaStream -> MediaRecorder (1s WebM chunks) -> room server -> each viewer
 *
 * Every chunk goes up once, addressed to the viewers who are ready for it; the server passes it on. Nothing travels
 * device to device, so it works on any network. A viewer can only start decoding at a keyframe, and a plain WebM
 * cluster boundary is not guaranteed to be one. So when someone joins we start a fresh recording: its first chunk
 * (WebM header + first cluster) always begins with a keyframe. Viewers already watching append that new header
 * seamlessly (see StreamReceiver).
 */
import { STREAM_PIECE } from '@wp/shared';
import { sendBacklog, sendStreamPiece } from './room';

const VIDEO_CODECS = ['vp8', 'vp9'];
const MIN_BITRATE = 350_000;
// our own upload is this far behind: skip a chunk (everyone restarts from the next fresh recording) and lower the bitrate
const HOST_BACKLOG = 6_000_000;

/**
 * Codec string for the stream. It must match the tracks that really exist: if we declare Opus audio
 * but the captured stream has none (a file without audio, or audio the browser cannot decode),
 * viewers' MediaSource rejects the stream with "Playback error".
 */
export function pickCodecs(withAudio = true): string | null {
  if (typeof MediaRecorder === 'undefined' || typeof MediaSource === 'undefined') return null;
  for (const vc of VIDEO_CODECS) {
    const c = withAudio ? `${vc},opus` : vc;
    if (MediaRecorder.isTypeSupported(`video/webm;codecs=${c}`) && MediaSource.isTypeSupported(`video/webm; codecs="${c}"`)) {
      return c;
    }
  }
  return null;
}

export interface ViewerStat {
  id: string;
  lag: number;
  backlog: number;
}

interface Viewer {
  id: string;
  ready: boolean;
  /** asked to watch, waiting for the next fresh recording to start from a keyframe */
  fresh: boolean;
  lag: number;
}

export interface HostStreamerOptions {
  stream: MediaStream;
  codecs: string;
  bitrate: number;
  maxViewers: number;
  signal: (to: string, data: unknown) => void;
  onStats: (stats: ViewerStat[]) => void;
  onBitrate: (bps: number) => void;
}

export class HostStreamer {
  private rec: MediaRecorder | null = null;
  private viewers = new Map<string, Viewer>();
  private firstChunk = true;
  private restartPending = false;
  private lastRestart = 0;
  private paused = false;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private overflows: number[] = [];
  private statsTimer: number | undefined;
  private bitrate: number;
  private chunkNo = 0;

  constructor(private o: HostStreamerOptions) {
    this.bitrate = o.bitrate;
  }

  start(): void {
    this.startRecorder();
    this.statsTimer = window.setInterval(() => this.emitStats(), 2000);
  }

  setBitrate(bps: number): void {
    this.bitrate = Math.max(MIN_BITRATE, Math.round(bps));
    this.o.onBitrate(this.bitrate);
    this.restartRecorder();
  }

  /**
   * The host paused/resumed their own player. A running recorder keeps wall-clock time while the
   * picture is frozen, which would leave a hole in the viewers' timeline. Pausing the recorder
   * cuts the paused time out, so playback continues seamlessly on resume.
   */
  setPaused(paused: boolean): void {
    this.paused = paused;
    const rec = this.rec;
    if (!rec) return;
    try {
      if (paused) {
        // flush what we have so viewers get the last frames now, then stop recording
        if (!this.firstChunk && rec.state === 'recording') {
          rec.requestData();
          rec.pause();
        }
      } else if (rec.state === 'paused') {
        rec.resume();
      }
    } catch {
      /* recorder already stopped */
    }
  }

  stop(): void {
    this.stopped = true;
    window.clearInterval(this.statsTimer);
    try {
      if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    } catch {
      /* ignore */
    }
    this.viewers.clear();
  }

  /** Forgets viewers who left the room. */
  keepOnly(ids: string[]): void {
    const keep = new Set(ids);
    let changed = false;
    for (const id of [...this.viewers.keys()]) {
      if (!keep.has(id)) {
        this.viewers.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitStats();
  }

  // ---------------------------------------------------------------- recorder

  private startRecorder(): void {
    if (this.stopped) return;
    const rec = new MediaRecorder(this.o.stream, {
      mimeType: `video/webm;codecs=${this.o.codecs}`,
      videoBitsPerSecond: this.bitrate,
      audioBitsPerSecond: 128_000,
    });
    this.firstChunk = true;
    this.lastRestart = Date.now();
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const blob = e.data;
      this.chain = this.chain.then(async () => {
        this.onChunk(new Uint8Array(await blob.arrayBuffer()));
      });
    };
    rec.start(1000);
    this.rec = rec;
    // Note: a recorder pointed at a paused video emits nothing until frames flow again (verified in
    // Chrome, seeking does not help), so someone who joins during a pause sees the picture on resume.
  }

  /** Stop and start a fresh recorder (new WebM header). Viewers append it in 'sequence' mode. */
  private restartRecorder(): void {
    const old = this.rec;
    if (!old || old.state === 'inactive') return this.startRecorder();
    old.onstop = () => {
      this.chain = this.chain.then(() => this.startRecorder());
    };
    old.stop();
  }

  private onChunk(buf: Uint8Array): void {
    if (this.firstChunk) {
      // header + first cluster of a fresh recording: a safe place for waiting viewers to start
      this.firstChunk = false;
      this.restartPending = false;
      for (const v of this.viewers.values()) {
        if (v.fresh) {
          v.fresh = false;
          v.ready = true;
        }
      }
    }
    const ready = [...this.viewers.values()].filter((v) => v.ready);
    if (ready.length > 0) {
      if (sendBacklog() > HOST_BACKLOG) {
        // our own connection cannot keep up: skip this chunk, start everyone again from a fresh recording, send less
        for (const v of ready) {
          v.ready = false;
          v.fresh = true;
        }
        this.lowerBitrate();
        this.requestFreshStart();
      } else {
        const ids = ready.map((v) => v.id);
        const chunk = this.chunkNo++;
        for (let i = 0; i < buf.length; i += STREAM_PIECE) {
          const end = Math.min(i + STREAM_PIECE, buf.length);
          sendStreamPiece(ids, buf.subarray(i, end), { chunk, first: i === 0, last: end >= buf.length });
        }
      }
    }
    // a fresh recording started while the host is paused: it has now delivered its header + first
    // frame (so a late joiner can see the paused picture), so stop it until the host plays again
    if (this.paused && this.rec?.state === 'recording') {
      try {
        this.rec.pause();
      } catch {
        /* ignore */
      }
    }
  }

  /** A new viewer connected: begin a fresh recording so they can start at a keyframe (rate-limited). */
  private requestFreshStart(): void {
    if (this.restartPending) return;
    this.restartPending = true;
    const wait = Math.max(0, 2000 - (Date.now() - this.lastRestart));
    window.setTimeout(() => {
      if (!this.stopped) this.restartRecorder();
    }, wait);
  }

  /** Falling behind twice within a minute lowers the bitrate. */
  private lowerBitrate(): void {
    const now = Date.now();
    this.overflows = this.overflows.filter((t) => now - t < 60_000);
    this.overflows.push(now);
    if (this.overflows.length >= 2 && this.bitrate > MIN_BITRATE * 1.2) {
      this.overflows = [];
      this.setBitrate(this.bitrate * 0.6);
    }
  }

  // ------------------------------------------------------------------ viewers

  handleSignal(from: string, data: any): void {
    switch (data?.kind) {
      case 'stream-request':
        if (!this.viewers.has(from) && this.viewers.size >= this.o.maxViewers) {
          this.o.signal(from, { kind: 'stream-full' });
          return;
        }
        this.addViewer(from);
        return;
      case 'stream-lag': {
        const v = this.viewers.get(from);
        if (v && Number.isFinite(data.v)) v.lag = data.v;
        return;
      }
      case 'stream-slow': {
        // the server could not keep up sending to them: they start again from the next fresh recording
        const v = this.viewers.get(from);
        if (!v) return;
        v.ready = false;
        v.fresh = true;
        this.lowerBitrate();
        this.requestFreshStart();
        return;
      }
      case 'stream-bye':
        if (this.viewers.delete(from)) this.emitStats();
        return;
    }
  }

  private addViewer(id: string): void {
    this.viewers.set(id, { id, ready: false, fresh: true, lag: 0 });
    this.o.signal(id, { kind: 'stream-hello', codecs: this.o.codecs });
    // a fresh recording that has not sent its first chunk yet is their start point; otherwise start one
    if (this.firstChunk) this.restartPending = true;
    else this.requestFreshStart();
    this.emitStats();
  }

  private emitStats(): void {
    const backlog = sendBacklog();
    this.o.onStats([...this.viewers.values()].filter((v) => v.ready).map((v) => ({ id: v.id, lag: v.lag, backlog })));
  }
}
