/**
 * Viewer side of host-stream mode.
 *
 * Room server -> pieces of WebM chunks -> MediaSource ('sequence' mode) -> <video>
 *
 * The SourceBuffer is the viewer's DVR: it holds up to `keepSeconds` of history, so the
 * viewer can rewind inside it but never go past its end (the live edge).
 */
import type { StreamPiece } from './room';

const dbg = (...a: unknown[]): void => console.debug('[stream]', ...a);

export type RecvStatus = 'idle' | 'requesting' | 'connecting' | 'live' | 'lost' | 'full' | 'error';

/** No piece for this long while the host should be sending: ask again (they may have reloaded, or dropped us). */
const SILENCE_MS = 15_000;

export interface ReceiverOptions {
  video: HTMLVideoElement;
  signal: (to: string, data: unknown) => void;
  onStatus: (s: RecvStatus) => void;
  keepSeconds?: number;
}

export class StreamReceiver {
  private hostId: string | null = null;
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private codecs = '';
  private appended = false;
  private objectUrl = '';
  private queue: Uint8Array[] = [];
  /** the chunk being put back together from its pieces */
  private parts: Uint8Array[] = [];
  private partsChunk = -1;
  private retryTimer: number | undefined;
  private watchTimer: number | undefined;
  private retries = 0;
  private live = false;
  private lastPiece = 0;
  private destroyed = false;
  private keep: number;

  constructor(private o: ReceiverOptions) {
    this.keep = o.keepSeconds ?? 1800;
    this.watchTimer = window.setInterval(() => this.watch(), 3000);
  }

  /** Point at the current host (or null when there is none) and (re)connect. */
  setHost(id: string | null): void {
    if (this.hostId && this.hostId !== id) this.o.signal(this.hostId, { kind: 'stream-bye' });
    this.hostId = id;
    this.retries = 0;
    this.live = false;
    this.parts = [];
    if (id) this.request();
    else {
      window.clearTimeout(this.retryTimer);
      this.o.onStatus('idle');
    }
  }

  private request(): void {
    if (this.destroyed || !this.hostId) return;
    this.live = false;
    this.o.onStatus(this.retries > 0 ? 'lost' : 'requesting');
    this.o.signal(this.hostId, { kind: 'stream-request' });
    window.clearTimeout(this.retryTimer);
    // if the host never answers, try again with a growing delay
    this.retryTimer = window.setTimeout(() => {
      if (this.destroyed || !this.hostId || this.live) return;
      this.retries += 1;
      this.request();
    }, Math.min(4000 + this.retries * 2000, 12000));
  }

  /** The host went quiet for a long time while we were watching: ask again. The buffered video stays rewindable. */
  private watch(): void {
    if (!this.live || !this.hostId || this.destroyed) return;
    if (Date.now() - this.lastPiece > SILENCE_MS && !this.o.video.paused) {
      dbg('no stream data for a while: asking the host again');
      this.retries = 1;
      this.request();
    }
  }

  handleSignal(data: any): void {
    if (this.destroyed) return;
    switch (data?.kind) {
      case 'stream-full':
        window.clearTimeout(this.retryTimer);
        this.o.onStatus('full');
        return;
      case 'stream-hello':
        if (typeof data.codecs !== 'string') return;
        window.clearTimeout(this.retryTimer);
        this.retries = 0;
        this.live = true;
        this.lastPiece = Date.now();
        this.setupMse(data.codecs);
        this.o.onStatus('live');
        return;
    }
  }

  /** One piece of a chunk from the host. A chunk is only used when all its pieces arrived in order. */
  handlePiece(p: StreamPiece): void {
    if (this.destroyed || p.from !== this.hostId) return;
    this.lastPiece = Date.now();
    if (p.first) {
      this.parts = [p.bytes.slice()];
      this.partsChunk = p.chunk;
    } else if (this.parts.length > 0 && p.chunk === this.partsChunk) {
      this.parts.push(p.bytes.slice());
    } else {
      // a piece of a chunk whose start we never got: it is useless on its own
      this.parts = [];
      return;
    }
    if (!p.last) return;
    const total = this.parts.reduce((n, x) => n + x.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const x of this.parts) {
      out.set(x, off);
      off += x.length;
    }
    this.parts = [];
    this.queue.push(out);
    this.pump();
  }

  // --------------------------------------------------------------------- MSE

  private setupMse(codecs: string): void {
    if (this.ms && this.sb && this.codecs === codecs && this.ms.readyState === 'open') return; // keep DVR across reconnects
    this.disposeMse();
    this.codecs = codecs;
    const type = `video/webm; codecs="${codecs}"`;
    const ms = new MediaSource();
    this.ms = ms;
    this.objectUrl = URL.createObjectURL(ms);
    this.o.video.src = this.objectUrl;
    ms.addEventListener(
      'sourceopen',
      () => {
        try {
          const sb = ms.addSourceBuffer(type);
          sb.mode = 'sequence';
          sb.addEventListener('updateend', () => this.pump());
          sb.addEventListener('error', () => {
            dbg('SourceBuffer error event; MediaSource is', ms.readyState);
            this.o.onStatus('error');
          });
          this.sb = sb;
          this.pump();
        } catch {
          this.o.onStatus('error');
        }
      },
      { once: true },
    );
  }

  private disposeMse(): void {
    this.sb = null;
    this.appended = false;
    this.queue = [];
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = '';
    this.ms = null;
  }

  private pump(): void {
    const sb = this.sb;
    if (!sb || sb.updating || !this.ms || this.ms.readyState !== 'open') return;
    const next = this.queue.shift();
    if (!next) {
      this.maybeTrim();
      return;
    }
    try {
      // A new WebM header mid-stream (host resumed, bitrate changed, or we reconnected) starts a new
      // recording. abort() resets the parser so it is not read as junk inside the old, still-open
      // cluster, and in 'sequence' mode the timeline continues from the end of what we already have.
      const isHeader = next[0] === 0x1a && next[1] === 0x45 && next[2] === 0xdf && next[3] === 0xa3;
      if (isHeader && this.appended) {
        dbg('new WebM header: abort() to chain a new recording');
        sb.abort();
      }
      this.appended = true;
      sb.appendBuffer(next as BufferSource);
    } catch (e) {
      dbg('append failed', (e as Error).name, (e as Error).message);
      if ((e as DOMException).name === 'QuotaExceededError') {
        this.queue.unshift(next);
        this.forceTrim();
      } else {
        this.o.onStatus('error');
      }
    }
  }

  /** Drop history older than `keep` seconds, never anything the viewer is currently watching. */
  private maybeTrim(): void {
    const sb = this.sb;
    const r = this.range();
    if (!sb || sb.updating || !r) return;
    const removeEnd = Math.min(r.end - this.keep, this.o.video.currentTime - 10);
    if (removeEnd > r.start + 1) {
      try {
        sb.remove(r.start, removeEnd);
      } catch {
        /* ignore */
      }
    }
  }

  private forceTrim(): void {
    const sb = this.sb;
    const r = this.range();
    if (!sb || sb.updating || !r) return;
    const to = Math.max(r.start + 1, Math.min(this.o.video.currentTime - 5, r.end - 60));
    try {
      sb.remove(r.start, to);
    } catch {
      /* ignore */
    }
  }

  /** Does the stream carry sound? null until the host's hello says what is in it. */
  hasAudio(): boolean | null {
    if (!this.codecs) return null;
    return this.codecs.includes('opus') || this.codecs.includes('vorbis');
  }

  /** Buffered window in seconds: [start of history, live edge]. */
  range(): { start: number; end: number } | null {
    const sb = this.sb;
    if (!sb) return null;
    try {
      const b = sb.buffered;
      if (b.length === 0) return null;
      return { start: b.start(0), end: b.end(b.length - 1) };
    } catch {
      return null;
    }
  }

  sendLag(seconds: number): void {
    if (this.live && this.hostId) this.o.signal(this.hostId, { kind: 'stream-lag', v: Math.max(0, seconds) });
  }

  destroy(): void {
    if (this.hostId) this.o.signal(this.hostId, { kind: 'stream-bye' });
    this.destroyed = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.watchTimer);
    this.disposeMse();
    this.o.video.removeAttribute('src');
  }
}
