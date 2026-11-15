/**
 * Host side of host-stream mode.
 *
 *   MediaStream -> MediaRecorder (1s WebM chunks) -> RTCDataChannel (one per viewer)
 *
 * Nothing touches our server except the WebRTC handshake. A viewer can only start decoding at a
 * keyframe, and a plain WebM cluster boundary is not guaranteed to be one. So when someone joins
 * we start a fresh recording: its first chunk (WebM header + first cluster) always begins with a
 * keyframe. Viewers already watching append that new header seamlessly (see StreamReceiver).
 */

const VIDEO_CODECS = ['vp8', 'vp9'];
const PIECE = 15_000; // safe across browsers for SCTP messages
const MAX_BACKLOG = 8_000_000; // bytes queued on one viewer before we drop them
const MIN_BITRATE = 350_000;

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

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  ready: boolean;
  /** connected, but waiting for the next fresh recording to start from a keyframe */
  fresh: boolean;
  lag: number;
  haveRemote: boolean;
  pendingIce: RTCIceCandidateInit[];
}

export interface HostStreamerOptions {
  stream: MediaStream;
  codecs: string;
  bitrate: number;
  iceServers: RTCIceServer[];
  maxViewers: number;
  signal: (to: string, data: unknown) => void;
  onStats: (stats: ViewerStat[]) => void;
  onBitrate: (bps: number) => void;
}

export class HostStreamer {
  private rec: MediaRecorder | null = null;
  private peers = new Map<string, Peer>();
  private firstChunk = true;
  private restartPending = false;
  private lastRestart = 0;
  private paused = false;
  private chain: Promise<void> = Promise.resolve();
  private stopped = false;
  private overflows: number[] = [];
  private statsTimer: number | undefined;
  private bitrate: number;

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
    for (const p of this.peers.values()) this.closePeer(p);
    this.peers.clear();
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
      for (const p of this.peers.values()) {
        if (p.fresh) {
          p.fresh = false;
          p.ready = true;
        }
      }
    }
    for (const p of [...this.peers.values()]) if (p.ready) this.sendBlob(p, buf);
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

  private sendBlob(p: Peer, buf: Uint8Array): void {
    const dc = p.dc;
    if (dc.readyState !== 'open') return;
    if (dc.bufferedAmount > MAX_BACKLOG) {
      this.dropSlow(p);
      return;
    }
    for (let i = 0; i < buf.length; i += PIECE) {
      const part = buf.subarray(i, Math.min(i + PIECE, buf.length));
      const out = new Uint8Array(part.length + 1);
      out[0] = i + PIECE >= buf.length ? 1 : 0;
      out.set(part, 1);
      dc.send(out);
    }
  }

  /** A viewer that cannot keep up gets dropped (they reconnect at the live edge); repeated drops lower the bitrate. */
  private dropSlow(p: Peer): void {
    this.closePeer(p);
    this.peers.delete(p.id);
    const now = Date.now();
    this.overflows = this.overflows.filter((t) => now - t < 60_000);
    this.overflows.push(now);
    if (this.overflows.length >= 2 && this.bitrate > MIN_BITRATE * 1.2) {
      this.overflows = [];
      this.setBitrate(this.bitrate * 0.6);
    }
  }

  // ------------------------------------------------------------------ peers

  async handleSignal(from: string, data: any): Promise<void> {
    switch (data?.kind) {
      case 'stream-request':
        if (!this.peers.has(from) && this.peers.size >= this.o.maxViewers) {
          this.o.signal(from, { kind: 'stream-full' });
          return;
        }
        await this.createPeer(from);
        return;
      case 'stream-answer': {
        const p = this.peers.get(from);
        if (!p) return;
        await p.pc.setRemoteDescription(data.sdp);
        p.haveRemote = true;
        for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => undefined);
        return;
      }
      case 'stream-ice': {
        const p = this.peers.get(from);
        if (!p || !data.candidate) return;
        if (p.haveRemote) await p.pc.addIceCandidate(data.candidate).catch(() => undefined);
        else p.pendingIce.push(data.candidate);
        return;
      }
    }
  }

  private async createPeer(id: string): Promise<void> {
    const prev = this.peers.get(id);
    if (prev) {
      this.closePeer(prev);
      this.peers.delete(id);
    }
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    const dc = pc.createDataChannel('video', { ordered: true });
    dc.binaryType = 'arraybuffer';
    const peer: Peer = { id, pc, dc, ready: false, fresh: false, lag: 0, haveRemote: false, pendingIce: [] };
    this.peers.set(id, peer);

    pc.onicecandidate = (e) => {
      if (e.candidate) this.o.signal(id, { kind: 'stream-ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.removePeer(peer);
    };
    dc.onclose = () => this.removePeer(peer);
    dc.onopen = () => {
      dc.send(JSON.stringify({ t: 'hello', codecs: this.o.codecs }));
      if (this.firstChunk) {
        // a fresh recording is already pending (just started): its first chunk is our start point
        peer.fresh = true;
        this.restartPending = true;
      } else {
        peer.fresh = true;
        this.requestFreshStart();
      }
      this.emitStats();
    };
    dc.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      try {
        const m = JSON.parse(e.data) as { t: string; v: number };
        if (m.t === 'lag' && Number.isFinite(m.v)) peer.lag = m.v;
      } catch {
        /* ignore */
      }
    };

    await pc.setLocalDescription(await pc.createOffer());
    this.o.signal(id, { kind: 'stream-offer', sdp: pc.localDescription });
  }

  private removePeer(p: Peer): void {
    if (this.peers.get(p.id) === p) {
      this.peers.delete(p.id);
      this.closePeer(p);
      this.emitStats();
    }
  }

  private closePeer(p: Peer): void {
    p.ready = false;
    try {
      p.dc.close();
    } catch {
      /* ignore */
    }
    try {
      p.pc.close();
    } catch {
      /* ignore */
    }
  }

  private emitStats(): void {
    this.o.onStats(
      [...this.peers.values()].filter((p) => p.ready).map((p) => ({ id: p.id, lag: p.lag, backlog: p.dc.bufferedAmount })),
    );
  }
}
