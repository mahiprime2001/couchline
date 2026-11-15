/**
 * Small voice channel: a WebRTC audio + video mesh between members who joined voice.
 * To avoid both sides offering at once, the peer with the larger id always makes the offer.
 *
 * Every connection carries a video slot from the start, so turning a camera on or off is just
 * replaceTrack(): no renegotiation, and a member without a camera simply sends nothing.
 */

interface VPeer {
  pc: RTCPeerConnection;
  audio: HTMLAudioElement;
  /** The camera slot: sends our camera (when on) and receives theirs. Null until negotiated. */
  video: RTCRtpTransceiver | null;
  pendingIce: RTCIceCandidateInit[];
  haveRemote: boolean;
}

export interface VoiceOptions {
  myId: string;
  iceServers: RTCIceServer[];
  signal: (to: string, data: unknown) => void;
  container: HTMLElement;
  /** A remote member's camera track arrived, or (track = null) their connection went away. */
  onRemoteVideo: (id: string, track: MediaStreamTrack | null) => void;
  /** A remote member switched their camera on or off. Browsers do not reliably report this themselves. */
  onRemoteCam: (id: string, on: boolean) => void;
}

const CAMERA = { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' };

export class VoiceManager {
  private local: MediaStream | null = null;
  private cam: MediaStreamTrack | null = null;
  /** the camera is kept open once granted; "off" only stops sending it, so turning it on again never re-asks */
  private camOn = false;
  private peers = new Map<string, VPeer>();

  constructor(private o: VoiceOptions) {}

  get active(): boolean {
    return this.local !== null;
  }

  /** Our own camera track while it is on, otherwise null. */
  get camera(): MediaStreamTrack | null {
    return this.camOn ? this.cam : null;
  }

  /** `withCamera`: ask for microphone and camera in one permission prompt (falls back to microphone only) */
  async join(withCamera = false): Promise<void> {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream: MediaStream | null = null;
    if (withCamera) stream = await navigator.mediaDevices.getUserMedia({ audio, video: CAMERA }).catch(() => null);
    stream ??= await navigator.mediaDevices.getUserMedia({ audio });
    this.cam = stream.getVideoTracks()[0] ?? null;
    this.camOn = this.cam !== null;
    this.local = new MediaStream(stream.getAudioTracks());
  }

  leave(): void {
    for (const [id, p] of this.peers) this.drop(id, p);
    this.peers.clear();
    this.local?.getTracks().forEach((t) => t.stop());
    this.local = null;
    this.cam?.stop();
    this.cam = null;
    this.camOn = false;
  }

  setMicEnabled(on: boolean): void {
    this.local?.getAudioTracks().forEach((t) => {
      t.enabled = on;
    });
  }

  /** Turn our camera on (asks the browser the first time) or off (stops sending it; the device stays open until you leave voice). */
  async setCamera(on: boolean): Promise<void> {
    if (!this.local) return;
    if (!on) {
      if (this.cam) this.cam.enabled = false;
      this.camOn = false;
      for (const [id, p] of this.peers) {
        void p.video?.sender.replaceTrack(null);
        this.o.signal(id, { kind: 'voice-cam', on: false });
      }
      return;
    }
    if (this.camOn) return;
    if (!this.cam || this.cam.readyState === 'ended') {
      const stream = await navigator.mediaDevices.getUserMedia({ video: CAMERA });
      const track = stream.getVideoTracks()[0] ?? null;
      // left voice, or asked twice, while the browser was asking: do not keep a camera nobody uses
      if (!this.local || this.cam?.readyState === 'live') {
        track?.stop();
        if (!this.local) return;
      } else this.cam = track;
    }
    if (!this.cam) return;
    this.cam.enabled = true;
    this.camOn = true;
    for (const [id, p] of this.peers) {
      void p.video?.sender.replaceTrack(this.cam);
      this.o.signal(id, { kind: 'voice-cam', on: true });
    }
  }

  /** Called whenever the member list changes: connect to new voice members, drop the ones who left. */
  reconcile(voiceIds: string[]): void {
    if (!this.local) return;
    const want = new Set(voiceIds.filter((id) => id !== this.o.myId));
    for (const [id, p] of [...this.peers]) {
      if (!want.has(id)) {
        this.drop(id, p);
        this.peers.delete(id);
      }
    }
    for (const id of want) {
      if (!this.peers.has(id) && this.o.myId > id) void this.call(id);
    }
  }

  private makePeer(id: string): VPeer {
    const pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    const audio = document.createElement('audio');
    audio.autoplay = true;
    this.o.container.appendChild(audio);
    const peer: VPeer = { pc, audio, video: null, pendingIce: [], haveRemote: false };
    this.peers.set(id, peer);
    this.local?.getAudioTracks().forEach((t) => pc.addTrack(t, this.local!));
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') this.o.onRemoteVideo(id, e.track);
      else audio.srcObject = e.streams[0] ?? null;
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.o.signal(id, { kind: 'voice-ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (this.peers.get(id) === peer) {
          this.drop(id, peer);
          this.peers.delete(id);
        }
      }
    };
    return peer;
  }

  private async call(id: string): Promise<void> {
    const p = this.makePeer(id);
    p.video = p.pc.addTransceiver('video', { direction: 'sendrecv' });
    if (this.camOn && this.cam) void p.video.sender.replaceTrack(this.cam);
    await p.pc.setLocalDescription(await p.pc.createOffer());
    this.o.signal(id, { kind: 'voice-offer', sdp: p.pc.localDescription, cam: this.camOn });
  }

  async handleSignal(from: string, data: any): Promise<void> {
    if (!this.local) return;
    switch (data?.kind) {
      case 'voice-offer': {
        const old = this.peers.get(from);
        if (old) {
          this.drop(from, old);
          this.peers.delete(from);
        }
        const p = this.makePeer(from);
        await p.pc.setRemoteDescription(data.sdp);
        // the offer made a video slot for us; switch it to send as well, so our camera can reach them
        p.video = p.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video') ?? null;
        if (p.video) {
          p.video.direction = 'sendrecv';
          if (this.camOn && this.cam) void p.video.sender.replaceTrack(this.cam);
        }
        p.haveRemote = true;
        for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => undefined);
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        this.o.onRemoteCam(from, !!data.cam);
        this.o.signal(from, { kind: 'voice-answer', sdp: p.pc.localDescription, cam: this.camOn });
        return;
      }
      case 'voice-answer': {
        const p = this.peers.get(from);
        if (!p) return;
        await p.pc.setRemoteDescription(data.sdp);
        p.haveRemote = true;
        this.o.onRemoteCam(from, !!data.cam);
        for (const c of p.pendingIce.splice(0)) await p.pc.addIceCandidate(c).catch(() => undefined);
        return;
      }
      case 'voice-cam': {
        this.o.onRemoteCam(from, !!data.on);
        return;
      }
      case 'voice-ice': {
        const p = this.peers.get(from);
        if (!p || !data.candidate) return;
        if (p.haveRemote) await p.pc.addIceCandidate(data.candidate).catch(() => undefined);
        else p.pendingIce.push(data.candidate);
        return;
      }
    }
  }

  private drop(id: string, p: VPeer): void {
    try {
      p.pc.close();
    } catch {
      /* ignore */
    }
    p.audio.srcObject = null;
    p.audio.remove();
    this.o.onRemoteVideo(id, null);
    this.o.onRemoteCam(id, false);
  }
}
