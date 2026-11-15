/**
 * Viewer side of host-stream mode.
 *
 * Data channel -> MediaSource (WebM, 'sequence' mode) -> <video>
 *
 * The SourceBuffer is the viewer's DVR: it holds up to `keepSeconds` of history, so the
 * viewer can rewind inside it but never go past its end (the live edge).
 */

const dbg = (...a: unknown[]): void => console.debug('[stream]', ...a);

export type RecvStatus ='idle' | 'requesting' | 'connecting' | 'live' | 'lost' | 'full' | 'error';

export interface ReceiverOptions {
  video: HTMLVideoElement;
  iceServers: RTCIceServer[];
  signal: (to: string, data: unknown) => void;
  onStatus: (s: RecvStatus) => void;
  keepSeconds?: number;
}

export class StreamReceiver {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private hostId: string | null = null;
  private haveRemote = false;
  private pendingIce: RTCIceCandidateInit[] = [];
  private ms: MediaSource | null = null;
  private sb: SourceBuffer | null = null;
  private codecs = '';
  private appended = false;
  private objectUrl = '';
  private queue: Uint8Array[] = [];
  private parts: Uint8Array[] = [];
  private retryTimer: number | undefined;
  private retries = 0;
  private destroyed = false;
  private keep: number;

  constructor(private o: ReceiverOptions) {
    this.keep = o.keepSeconds ?? 1800;
  }

  /** Point at the current host (or null when there is none) and (re)connect. */
  setHost(id: string | null): void {
    this.hostId = id;
    this.retries = 0;
    this.closeConnection();
    if (id) this.request();
    else this.o.onStatus('idle');
  }

  private request(): void {
    if (this.destroyed || !this.hostId) return;
    this.o.onStatus('requesting');
    this.o.signal(this.hostId, { kind: 'stream-request' });
    window.clearTimeout(this.retryTimer);
    // if the host never answers, try again with a growing delay
    this.retryTimer = window.setTimeout(() => {
      if (this.destroyed || !this.hostId) return;
      this.retries += 1;
      this.closeConnection();
      this.request();
    }, Math.min(4000 + this.retries * 2000, 12000));
  }

  async handleSignal(data: any): Promise<void> {
    if (this.destroyed) return;
    switch (data?.kind) {
      case 'stream-full':
        window.clearTimeout(this.retryTimer);
        this.o.onStatus('full');
        return;
      case 'stream-offer': {
        this.closeConnection();
        this.o.onStatus('connecting');
        const pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
        this.pc = pc;
        pc.onicecandidate = (e) => {
          if (e.candidate && this.hostId) this.o.signal(this.hostId, { kind: 'stream-ice', candidate: e.candidate.toJSON() });
        };
        pc.ondatachannel = (e) => this.bindChannel(e.channel);
        pc.onconnectionstatechange = () => {
          if (pc !== this.pc) return;
          if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.lost();
        };
        await pc.setRemoteDescription(data.sdp);
        this.haveRemote = true;
        for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
        await pc.setLocalDescription(await pc.createAnswer());
        if (this.hostId) this.o.signal(this.hostId, { kind: 'stream-answer', sdp: pc.localDescription });
        return;
      }
      case 'stream-ice':
        if (!data.candidate) return;
        if (this.pc && this.haveRemote) await this.pc.addIceCandidate(data.candidate).catch(() => undefined);
        else this.pendingIce.push(data.candidate);
        return;
    }
  }

  private bindChannel(dc: RTCDataChannel): void {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      window.clearTimeout(this.retryTimer);
      this.retries = 0;
      this.o.onStatus('live');
    };
    dc.onclose = () => {
      if (dc === this.dc) this.lost();
    };
    dc.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const m = JSON.parse(ev.data) as { t: string; codecs?: string };
          if (m.t === 'hello' && m.codecs) this.setupMse(m.codecs);
        } catch {
          /* ignore */
        }
        return;
      }
      const u8 = new Uint8Array(ev.data as ArrayBuffer);
      if (u8.length < 2) return;
      this.parts.push(u8.subarray(1));
      if (u8[0] & 1) {
        const total = this.parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(total);
        let off = 0;
        for (const p of this.parts) {
          out.set(p, off);
          off += p.length;
        }
        this.parts = [];
        this.queue.push(out);
        this.pump();
      }
    };
  }

  /** Connection dropped but the host still wants to stream: retry. The buffered video stays rewindable. */
  private lost(): void {
    this.closeConnection();
    if (this.destroyed || !this.hostId) return;
    this.o.onStatus('lost');
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => this.request(), Math.min(1500 + this.retries * 1500, 10000));
    this.retries += 1;
  }

  private closeConnection(): void {
    this.parts = [];
    this.haveRemote = false;
    this.pendingIce = [];
    const dc = this.dc;
    const pc = this.pc;
    this.dc = null;
    this.pc = null;
    try {
      dc?.close();
    } catch {
      /* ignore */
    }
    try {
      pc?.close();
    } catch {
      /* ignore */
    }
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
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify({ t: 'lag', v: Math.max(0, seconds) }));
  }

  destroy(): void {
    this.destroyed = true;
    window.clearTimeout(this.retryTimer);
    this.closeConnection();
    this.disposeMse();
    this.o.video.removeAttribute('src');
  }
}
