/**
 * Screen share over WebRTC. The picture goes from the host to a few viewers directly, and those viewers pass it on
 * to others, so a viewer with a weak upload does not have to send to everyone. The room server only relays the
 * handshake: "signal" messages whose kind starts with "rtc-". A viewer who cannot connect at all falls back to the
 * server path (hostStreamer.ts + StreamReceiver), so nobody is left without a picture.
 *
 *   host ── viewer A ── viewer C
 *       └── viewer B ── viewer D
 *
 * The host places each new viewer: the first MAX_CHILDREN get the picture from the host, the rest are sent to one of
 * those, which passes it on (up to MAX_CHILDREN each). A room of up to 6 viewers fits; any more use the server path.
 */

export type RtcSend = (to: string, data: unknown) => void;

/** how long a viewer waits for a picture before asking for the server path instead */
const CONNECT_MS = 12_000;
/** viewers that get the picture from one node: the host directly, or a viewer passing it on */
const MAX_CHILDREN = 2;
/** the most a node sends to each viewer; each viewer's connection adapts below it */
const SEND_BITRATE = 2_500_000;

/** a line in the browser console for each step of a direct connection, so a failed one shows where it stopped */
const log = (...a: unknown[]) => console.info('[rtc]', ...a);

let iceCache: Promise<RTCIceServer[]> | null = null;

/** The STUN/TURN servers from the room server (/api/ice). Falls back to one public STUN server if that fails. */
export function iceServers(): Promise<RTCIceServer[]> {
  iceCache ??= fetch('/api/ice')
    .then((r) => r.json() as Promise<{ iceServers?: RTCIceServer[] }>)
    .then((j) => (j.iceServers?.length ? j.iceServers : [{ urls: 'stun:stun.l.google.com:19302' }]))
    .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
  return iceCache;
}

/** Caps the video bitrate of a sender, and keeps the frame rate when the connection is short of bandwidth. */
async function capBitrate(sender: RTCRtpSender, bps: number): Promise<void> {
  const p = sender.getParameters();
  if (!p.encodings?.length) p.encodings = [{}];
  p.encodings[0]!.maxBitrate = bps;
  p.degradationPreference = 'maintain-framerate';
  await sender.setParameters(p);
}

/**
 * Every 5 seconds, the numbers that explain a choppy picture, in the console: frames per second sent or received,
 * why the sender is holding back (bandwidth or CPU), frames dropped, and how long the viewer buffers.
 */
function watchStats(pc: RTCPeerConnection, who: string): () => void {
  const timer = window.setInterval(async () => {
    try {
      const report = await pc.getStats();
      report.forEach((s: any) => {
        if (s.type === 'outbound-rtp' && s.kind === 'video') {
          log(who, `sending ${s.framesPerSecond ?? '?'} fps at ${s.frameWidth ?? '?'}x${s.frameHeight ?? '?'}, held back by: ${s.qualityLimitationReason ?? 'nothing'}`);
        }
        if (s.type === 'inbound-rtp' && s.kind === 'video') {
          const buffer = s.jitterBufferEmittedCount ? Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000) : '?';
          log(who, `receiving ${s.framesPerSecond ?? '?'} fps, dropped ${s.framesDropped ?? 0}, buffer ${buffer} ms, freezes ${s.freezeCount ?? 0}`);
        }
      });
    } catch {
      /* the connection closed between ticks */
    }
  }, 5000);
  return () => window.clearInterval(timer);
}

/**
 * Sends a picture to viewers, one connection each. The host uses it with `assign` (it places every viewer in the
 * tree); a viewer who passes the picture on uses it without, and serves up to MAX_CHILDREN viewers itself.
 */
export class RtcHost {
  private peers = new Map<string, RTCPeerConnection>(); // the connections this node sends the picture on
  private stops = new Map<string, () => void>(); // stops each connection's statistics
  private direct = new Set<string>(); // the viewers this node serves itself
  private relayOf = new Map<string, string>(); // viewer -> the viewer who passes the picture on to them
  private relayCount = new Map<string, number>(); // viewer -> how many they pass the picture on to
  private stream: MediaStream | null = null;
  private bitrate = SEND_BITRATE;
  private ice: RTCIceServer[] = [];

  constructor(private o: { signal: RtcSend; onCount?(n: number): void; assign?: boolean }) {}

  /** Tells the host's screen how many viewers are connected directly right now. */
  private report(): void {
    this.o.onCount?.([...this.direct].filter((id) => this.peers.get(id)?.connectionState === 'connected').length);
  }

  /** The STUN/TURN servers. Viewers who ask before they arrive get connections without them (LAN still works). */
  setIceServers(ice: RTCIceServer[]): void {
    this.ice = ice;
  }

  /** The picture to send now (null = none). Everyone connected is dropped and asks again for the new one. */
  setStream(stream: MediaStream | null, bitrate = SEND_BITRATE): void {
    this.stream = stream;
    this.bitrate = bitrate;
    this.closeAll();
  }

  /** Someone left the room: close their connection, and whoever they passed the picture on to. */
  keepOnly(ids: string[]): void {
    const keep = new Set(ids);
    for (const id of this.everyone()) if (!keep.has(id)) this.drop(id);
  }

  handleSignal(from: string, data: any): void {
    if (data?.kind === 'rtc-hello') {
      this.place(from);
      return;
    }
    const pc = this.peers.get(from);
    if (!pc) return;
    if (data?.kind === 'rtc-answer' && typeof data.sdp === 'string') {
      pc.setRemoteDescription({ type: 'answer', sdp: data.sdp }).catch(() => this.drop(from));
    } else if (data?.kind === 'rtc-ice' && data.candidate) {
      pc.addIceCandidate(data.candidate).catch(() => undefined);
    } else if (data?.kind === 'rtc-bye') {
      this.drop(from);
    }
  }

  /** Decides where a viewer gets the picture: from this node, or from a viewer it is passed to. */
  private place(id: string): void {
    if (!this.stream) return;
    this.drop(id); // asking again starts over
    if (this.o.assign && this.direct.size >= MAX_CHILDREN) {
      const parent = [...this.direct].find((p) => (this.relayCount.get(p) ?? 0) < MAX_CHILDREN);
      if (!parent) {
        log('host: the tree is full, this viewer uses the room server');
        this.o.signal(id, { kind: 'rtc-full' });
        return;
      }
      this.relayOf.set(id, parent);
      this.relayCount.set(parent, (this.relayCount.get(parent) ?? 0) + 1);
      log('host: passing the picture on to', id, 'through', parent);
      this.o.signal(id, { kind: 'rtc-parent', parent });
      return;
    }
    if (!this.o.assign && this.direct.size >= MAX_CHILDREN) {
      this.o.signal(id, { kind: 'rtc-full' });
      return;
    }
    this.direct.add(id);
    void this.offer(id);
  }

  private async offer(id: string): Promise<void> {
    const stream = this.stream;
    if (!stream) return;
    try {
      const pc = new RTCPeerConnection({ iceServers: this.ice });
      this.peers.set(id, pc);
      this.stops.set(id, watchStats(pc, `send→${id.slice(0, 6)}`));
      for (const track of stream.getTracks()) pc.addTrack(track, stream);
      pc.onicecandidate = (e) => {
        if (e.candidate) this.o.signal(id, { kind: 'rtc-ice', candidate: e.candidate.toJSON() });
      };
      pc.onconnectionstatechange = () => {
        log('send: connection', id.slice(0, 6), pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this.drop(id);
        this.report();
      };
      await pc.setLocalDescription(await pc.createOffer());
      this.o.signal(id, { kind: 'rtc-offer', sdp: pc.localDescription?.sdp });
      for (const s of pc.getSenders()) if (s.track?.kind === 'video') await capBitrate(s, this.bitrate);
    } catch (e) {
      log('send: could not make the offer', e);
      this.drop(id); // the viewer falls back to the room server
    }
  }

  /** Who this node is sending to, directly or passed on. */
  private everyone(): string[] {
    return [...new Set([...this.direct, ...this.relayOf.keys()])];
  }

  private drop(id: string): void {
    this.direct.delete(id);
    const parent = this.relayOf.get(id);
    if (parent !== undefined) {
      this.relayOf.delete(id);
      this.relayCount.set(parent, Math.max(0, (this.relayCount.get(parent) ?? 1) - 1));
    }
    const pc = this.peers.get(id);
    if (!pc) return;
    this.peers.delete(id);
    this.stops.get(id)?.();
    this.stops.delete(id);
    pc.close();
    this.report();
  }

  private closeAll(): void {
    for (const id of this.everyone()) this.drop(id);
    this.relayCount.clear();
  }

  stop(): void {
    this.stream = null;
    this.closeAll();
  }
}

/** The viewer side: asks for the picture, and reports when it cannot get one. */
export class RtcViewer {
  private pc: RTCPeerConnection | null = null;
  private host = '';
  private pending: RTCIceCandidateInit[] = [];
  private gotPicture = false;
  private timer = 0;
  private stopStats: () => void = () => undefined;

  constructor(private o: { signal: RtcSend; iceServers: RTCIceServer[]; onStream(s: MediaStream): void; onFail(): void }) {}

  connect(host: string): void {
    this.close();
    this.host = host;
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    } catch (e) {
      log('viewer: this browser cannot make a direct connection', e);
      this.o.onFail();
      return;
    }
    this.pc = pc;
    this.stopStats = watchStats(pc, 'viewer');
    pc.ontrack = (e) => {
      log('viewer: picture track arrived', e.track.kind);
      // play video as soon as it is decoded, instead of holding it in a buffer for smoothness (sound is left alone).
      // The trade-off: a slow network shows small stutters rather than a delayed picture.
      if (e.track.kind === 'video' && 'playoutDelayHint' in e.receiver) (e.receiver as RTCRtpReceiver & { playoutDelayHint: number }).playoutDelayHint = 0;
      this.gotPicture = true;
      window.clearTimeout(this.timer);
      this.o.onStream(e.streams[0] ?? new MediaStream([e.track]));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.o.signal(host, { kind: 'rtc-ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      log('viewer: connection', pc.connectionState);
      if (pc.connectionState === 'failed') this.o.onFail();
    };
    // no picture in time: a network that blocks direct connections. The server path takes over.
    this.timer = window.setTimeout(() => {
      if (this.gotPicture) return;
      log('viewer: no picture after', CONNECT_MS, 'ms, using the room server instead');
      this.o.onFail();
    }, CONNECT_MS);
    log('viewer: asking for the picture');
    this.o.signal(host, { kind: 'rtc-hello' });
  }

  handleSignal(from: string, data: any): void {
    const pc = this.pc;
    if (!pc || from !== this.host) return;
    if (data?.kind === 'rtc-offer' && typeof data.sdp === 'string') {
      void (async () => {
        await pc.setRemoteDescription({ type: 'offer', sdp: data.sdp });
        for (const c of this.pending.splice(0)) await pc.addIceCandidate(c).catch(() => undefined);
        await pc.setLocalDescription(await pc.createAnswer());
        this.o.signal(from, { kind: 'rtc-answer', sdp: pc.localDescription?.sdp });
      })().catch(() => this.o.onFail());
    } else if (data?.kind === 'rtc-ice' && data.candidate) {
      // candidates can arrive before the offer is applied: keep them until it is
      if (pc.remoteDescription) pc.addIceCandidate(data.candidate).catch(() => undefined);
      else this.pending.push(data.candidate);
    }
  }

  close(): void {
    window.clearTimeout(this.timer);
    this.stopStats();
    this.stopStats = () => undefined;
    if (this.pc && this.host) this.o.signal(this.host, { kind: 'rtc-bye' });
    this.pc?.close();
    this.pc = null;
    this.pending = [];
    this.gotPicture = false;
  }
}

/**
 * A viewer's whole connection: the picture comes from the host or from the viewer it is passed through, and once
 * this viewer has the picture, it passes it on to up to MAX_CHILDREN viewers of its own.
 */
export class RtcNode {
  private upstream: RtcViewer | null = null;
  private upstreamId = '';
  private hostId = '';
  private relay: RtcHost | null = null;
  private picture: MediaStream | null = null;

  constructor(private o: { iceServers: RTCIceServer[]; signal: RtcSend; onStream(s: MediaStream): void; onFail(): void }) {}

  connect(hostId: string): void {
    this.hostId = hostId;
    this.attach(hostId);
  }

  private attach(from: string): void {
    this.upstream?.close();
    this.upstreamId = from;
    this.upstream = new RtcViewer({
      iceServers: this.o.iceServers,
      signal: this.o.signal,
      onStream: (media) => this.onPicture(media),
      onFail: () => this.o.onFail(),
    });
    this.upstream.connect(from);
  }

  handleSignal(from: string, data: any): void {
    if (from === this.upstreamId) {
      if (from === this.hostId && data?.kind === 'rtc-parent' && typeof data.parent === 'string') {
        log('viewer: the host passed me on to', data.parent);
        this.attach(data.parent);
      } else if (data?.kind === 'rtc-full') {
        this.o.onFail(); // no room in the tree: the room server path
      } else {
        this.upstream?.handleSignal(from, data);
      }
      return;
    }
    this.relay?.handleSignal(from, data); // one of the viewers this node passes the picture on to
  }

  private onPicture(media: MediaStream): void {
    this.o.onStream(media);
    if (media === this.picture) return;
    this.picture = media;
    if (!this.relay) {
      this.relay = new RtcHost({ signal: this.o.signal });
      this.relay.setIceServers(this.o.iceServers);
    }
    this.relay.setStream(media, SEND_BITRATE);
  }

  stop(): void {
    this.upstream?.close();
    this.upstream = null;
    this.relay?.stop();
    this.relay = null;
    this.picture = null;
  }
}
