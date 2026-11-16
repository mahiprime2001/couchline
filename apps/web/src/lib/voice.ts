/**
 * Voice and camera through the room server (no peer-to-peer connections).
 *
 * Each person encodes their own microphone (Opus) and camera (VP8) with WebCodecs and sends the chunks through the
 * room's WebSocket. The server copies each chunk to the other people in voice. Each person decodes what they receive:
 * sound is scheduled through Web Audio, pictures are drawn on a canvas whose captured track feeds the call tiles.
 *
 * Capture uses an audio worklet and canvas snapshots (not insertable streams), so it also runs in Chrome on Android.
 * WebCodecs only exists on secure pages: https, or localhost.
 */
import type { ServerMsg } from '@wp/shared';
import { send, sendBacklog, sendMedia, type MediaChunk } from './room';

type MediaIn = Extract<ServerMsg, { t: 'media' }>;

const CAM = { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' };
/**
 * Camera quality steps. Sending starts on the lightest one, so the first picture is small and arrives quickly; it
 * moves up while the connection keeps up, and back down as soon as it falls behind.
 */
const LEVELS = [
  { width: 320, fps: 12, bitrate: 150_000 },
  { width: 480, fps: 15, bitrate: 280_000 },
  { width: 640, fps: 15, bitrate: 450_000 },
] as const;
const MAX_WIDTH = 640;
const AUDIO_BITRATE = 32_000;
const AUDIO_FRAME = 960; // samples per encoded chunk: 20 ms at 48 kHz
// A key frame is several times bigger than the others, and on a slow phone connection it holds up the sound queued
// behind it. Newcomers and broken pictures ask for one on demand, so the regular ones can be spaced out.
const KEY_EVERY_US = 5_000_000;
// When this device's connection is behind, sending more only adds delay. Pictures are skipped first (under a second
// of traffic waiting), sound only when it is far behind.
const VIDEO_BACKLOG = 50_000;
const AUDIO_BACKLOG = 150_000;

/** Runs on the audio thread: hands the microphone's samples to the page, one small block at a time. */
const CAPTURE_WORKLET = `
class WpCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('wp-capture', WpCapture);
`;

export interface VoiceOptions {
  myId: string;
  container: HTMLElement;
  /** A remote member's camera track arrived, or (track = null) their camera is no longer shown. */
  onRemoteVideo: (id: string, track: MediaStreamTrack | null) => void;
  /** A remote member switched their camera on or off. */
  onRemoteCam: (id: string, on: boolean) => void;
  /** Our own camera changed: the new track, or null when it is off (also when the phone stopped it and it could not come back). */
  onCamera?: (track: MediaStreamTrack | null) => void;
}

interface Remote {
  audioDec: AudioDecoder | null;
  audioFormat: string;
  /** when the next piece of their sound should start (audio clock, seconds) */
  nextTime: number;
  videoDec: VideoDecoder | null;
  /** their picture is drawn here; the canvas's captured track is what the call tile shows */
  canvas: HTMLCanvasElement | null;
  track: MediaStreamTrack | null;
  /** a video decoder waits for a key frame before it can start */
  gotKey: boolean;
  camOn: boolean;
  /** when the last video frame from them arrived (ms) */
  lastVideo: number;
  /** when we last asked them for a key frame (ms) */
  lastAsk: number;
  /** the number of the last video chunk from them, or -1 before the first */
  lastSeq: number;
}

/** Throws a clear message where voice cannot work, before the microphone is asked for. */
function assertVoiceSupport(): void {
  if (!window.isSecureContext) {
    throw new Error('Voice needs a secure page. Open this site with https:// (or use localhost on the same computer).');
  }
  if (typeof AudioEncoder === 'undefined' || typeof VideoEncoder === 'undefined' || typeof AudioDecoder === 'undefined' || typeof VideoDecoder === 'undefined' || typeof AudioWorkletNode === 'undefined') {
    throw new Error('This browser cannot do voice and video here. Use a recent Chrome or Edge.');
  }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

export class VoiceManager {
  /** sending our own microphone (and camera): only after Join voice */
  private active = false;
  /** playing the people in voice: from the moment we are in the room, so nobody has to join voice to watch */
  private receiving = false;
  private workletReady = false;
  private micNodes: AudioNode[] = [];
  /** browsers start sound only after a tap or key press: the first one wakes the audio up */
  private wake: (() => void) | null = null;
  private micOn = true;
  private mic: MediaStreamTrack | null = null;
  private cam: MediaStreamTrack | null = null;
  /** the camera is kept open once granted; "off" only stops sending it, so turning it on again never re-asks */
  private camOn = false;
  /** one audio context for capturing the microphone and playing everyone else */
  private ctx: AudioContext | null = null;
  private micBuf = new Float32Array(AUDIO_FRAME);
  private micFill = 0;
  private micSamples = 0;
  private aEnc: AudioEncoder | null = null;
  private vEnc: VideoEncoder | null = null;
  private vEncSize = '';
  private vForceKey = true;
  private lastKeyTs = -Infinity;
  /** numbers our video chunks, so receivers can tell when one went missing */
  private vSeq = 0;
  private aSeq = 0;
  /** which of LEVELS the camera is sent at, and what the connection has been doing lately */
  private level = 0;
  private levelSince = 0;
  private lastSkip = 0;
  private skips = 0;
  /** the people in voice we have already seen, so a newcomer gets a key frame at once */
  private known = new Set<string>();
  /** the camera plays in this hidden element so its picture can be copied to the canvas */
  private camVideo: HTMLVideoElement | null = null;
  private camCanvas: HTMLCanvasElement | null = null;
  private camTimer: number | undefined;
  private sweepTimer: number | undefined;
  private remotes = new Map<string, Remote>();

  constructor(private o: VoiceOptions) {}

  /** Our own camera track while it is on, otherwise null. */
  get camera(): MediaStreamTrack | null {
    return this.camOn ? this.cam : null;
  }

  /** `withCamera`: ask for microphone and camera in one permission prompt (falls back to microphone only). */
  async join(withCamera = false): Promise<void> {
    assertVoiceSupport();
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    let stream: MediaStream | null = null;
    if (withCamera) stream = await navigator.mediaDevices.getUserMedia({ audio, video: CAM }).catch(() => null);
    stream ??= await navigator.mediaDevices.getUserMedia({ audio });
    this.active = true;
    this.mic = stream.getAudioTracks()[0] ?? null;
    this.cam = stream.getVideoTracks()[0] ?? null;
    this.camOn = this.cam !== null;
    this.listen();
    await this.ctx?.resume().catch(() => undefined);
    if (this.mic) await this.startAudio(this.mic);
    if (!this.active) return;
    if (this.cam) this.startVideo(this.cam);
    send({ t: 'media', kind: 'cam', ts: 0, on: this.camOn });
  }

  /** Stops sending our microphone and camera. The others stay visible and audible. */
  leave(): void {
    this.active = false;
    this.stopVideoLoop();
    for (const n of this.micNodes) n.disconnect();
    this.micNodes = [];
    this.micFill = 0;
    this.mic?.stop();
    this.cam?.stop();
    this.mic = null;
    this.cam = null;
    this.camOn = false;
    this.closeAudio();
    this.closeVideo();
  }

  /**
   * Starts playing the people in voice. Called when we enter the room, so watching and listening need no Join voice.
   * Does nothing where the browser cannot decode (an http page, an old browser): the cards then show initials only.
   */
  listen(): void {
    if (this.receiving || !window.isSecureContext || typeof AudioDecoder === 'undefined' || typeof VideoDecoder === 'undefined') return;
    this.receiving = true;
    this.ctx ??= new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    this.sweepTimer = window.setInterval(() => this.sweep(), 1000);
    const wake = () => void this.ctx?.resume().catch(() => undefined);
    this.wake = wake;
    document.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
  }

  /** Leaving the room: stop sending and receiving, and let go of everything. */
  close(): void {
    this.leave();
    this.receiving = false;
    window.clearInterval(this.sweepTimer);
    if (this.wake) {
      document.removeEventListener('pointerdown', this.wake);
      document.removeEventListener('keydown', this.wake);
      this.wake = null;
    }
    for (const id of [...this.remotes.keys()]) this.forget(id);
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.workletReady = false;
  }

  setMicEnabled(on: boolean): void {
    this.micOn = on;
  }

  /** Turn our camera on (asks the browser the first time) or off (stops sending it; the device stays open until you leave voice). */
  async setCamera(on: boolean): Promise<void> {
    if (!this.active) return;
    if (!on) {
      this.camOn = false;
      send({ t: 'media', kind: 'cam', ts: 0, on: false });
      return;
    }
    if (this.camOn) return;
    if (!this.cam || this.cam.readyState === 'ended') {
      const stream = await navigator.mediaDevices.getUserMedia({ video: CAM });
      const track = stream.getVideoTracks()[0] ?? null;
      // left voice, or asked twice, while the browser was asking: do not keep a camera nobody uses
      if (!this.active || (this.cam && this.cam.readyState === 'live')) {
        track?.stop();
        return;
      }
      this.cam = track;
    }
    if (!this.cam) return;
    this.camOn = true;
    this.vForceKey = true;
    this.startVideo(this.cam);
    send({ t: 'media', kind: 'cam', ts: 0, on: true });
  }

  /**
   * The phone can stop our camera on its own (switching apps, locking the screen, another app taking it). The track
   * then ends while the camera still shows as on, and nobody receives anything. Open it again and carry on.
   */
  private watchCam(track: MediaStreamTrack): void {
    track.addEventListener('ended', () => {
      if (this.cam === track && this.camOn) void this.recoverCam();
    });
  }

  private async recoverCam(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: CAM });
      const track = stream.getVideoTracks()[0];
      if (!track) throw new Error('no camera');
      if (!this.active || !this.camOn) {
        track.stop();
        return;
      }
      this.cam = track;
      this.vForceKey = true;
      this.startVideo(track);
      this.o.onCamera?.(track);
    } catch {
      // could not reopen it: show the camera as off, so the button tells the truth
      if (!this.active) return;
      this.camOn = false;
      this.o.onCamera?.(null);
      send({ t: 'media', kind: 'cam', ts: 0, on: false });
    }
  }

  /** Forgets anyone who left voice: their picture and sound go, and the decoders are closed. */
  reconcile(voiceIds: string[]): void {
    if (!this.receiving) return;
    const want = new Set(voiceIds.filter((id) => id !== this.o.myId));
    for (const id of [...this.remotes.keys()]) if (!want.has(id)) this.forget(id);
    // someone new in voice: the next picture we send is a key frame, so theirs starts without waiting or asking
    for (const id of want) if (!this.known.has(id)) this.vForceKey = true;
    this.known = want;
  }

  /** A small note from someone else in voice: their camera went on or off, or they need a key frame from us. */
  handleMedia(m: MediaIn): void {
    if (!this.receiving || m.from === this.o.myId) return;
    // someone's picture broke on their side (or they just started watching): our next frame is a key frame
    if (m.kind === 'keyreq') {
      if (this.active) this.vForceKey = true;
      return;
    }
    if (m.kind !== 'cam') return;
    // an explicit on/off from them; a message sent before they joined voice can be dropped, so frames count too
    this.setRemoteCam(m.from, this.remoteOf(m.from), !!m.on);
  }

  /** An encoded piece of someone else's voice or camera (the server relays it as a binary frame). */
  handleChunk(c: MediaChunk): void {
    if (!this.receiving || c.from === this.o.myId) return;
    const r = this.remoteOf(c.from);
    if (c.kind === 'audio') this.playAudio(r, c);
    else this.playVideo(c.from, r, c);
  }

  private remoteOf(id: string): Remote {
    let r = this.remotes.get(id);
    if (!r) {
      r = this.makeRemote();
      this.remotes.set(id, r);
    }
    return r;
  }

  // ------------------------------------------------------------------ sending

  private async startAudio(track: MediaStreamTrack): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    // the capture code is loaded once per audio context: joining voice a second time must not load it again
    if (!this.workletReady) {
      const url = URL.createObjectURL(new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
        this.workletReady = true;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
    if (!this.active || this.ctx !== ctx) return;
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const capture = new AudioWorkletNode(ctx, 'wp-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    // a silent path to the speakers keeps the capture node running without playing our own voice back
    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(capture);
    capture.connect(silent);
    silent.connect(ctx.destination);
    capture.port.onmessage = (e) => this.onMicSamples(e.data as Float32Array, ctx.sampleRate);
    this.micNodes = [source, capture, silent];
  }

  /** Collects the microphone's small blocks into 20 ms frames and encodes each one. */
  private onMicSamples(block: Float32Array, rate: number): void {
    if (!this.active) return;
    let at = 0;
    while (at < block.length) {
      const n = Math.min(block.length - at, AUDIO_FRAME - this.micFill);
      this.micBuf.set(block.subarray(at, at + n), this.micFill);
      this.micFill += n;
      at += n;
      if (this.micFill < AUDIO_FRAME) break;
      this.micFill = 0;
      const timestamp = Math.round((this.micSamples / rate) * 1e6);
      this.micSamples += AUDIO_FRAME;
      // muted: nothing is sent, so the others hear silence rather than a quiet hiss.
      // far behind: dropping this 20 ms is better than everything arriving late
      if (!this.micOn || sendBacklog() > AUDIO_BACKLOG) continue;
      if (!this.aEnc) {
        this.aEnc = new AudioEncoder({
          output: (chunk) => this.sendChunk('audio', chunk, { rate, ch: 1, seq: this.aSeq++ }),
          error: () => this.closeAudio(),
        });
        this.aEnc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: AUDIO_BITRATE });
      }
      const frame = new AudioData({ format: 'f32', sampleRate: rate, numberOfFrames: AUDIO_FRAME, numberOfChannels: 1, timestamp, data: this.micBuf });
      this.aEnc.encode(frame);
      frame.close();
    }
  }

  private startVideo(track: MediaStreamTrack): void {
    this.stopVideoLoop();
    this.watchCam(track);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => undefined);
    this.camVideo = video;
    this.camCanvas ??= document.createElement('canvas');
    // every start begins light: a small first picture reaches the others quickly
    this.setLevel(0, performance.now());
  }

  /** Moves to another quality step: the loop runs at its frame rate, and the next picture uses its size and bitrate. */
  private setLevel(level: number, now: number): void {
    this.level = level;
    this.levelSince = now;
    this.skips = 0;
    window.clearInterval(this.camTimer);
    if (this.camVideo) this.camTimer = window.setInterval(() => this.sendFrame(), 1000 / LEVELS[level]!.fps);
  }

  /** A picture had to be skipped (the connection or the encoder is behind). Three in three seconds: step down. */
  private onPressure(now: number): void {
    if (now - this.lastSkip > 3000) this.skips = 0;
    this.skips++;
    this.lastSkip = now;
    if (this.skips >= 3 && this.level > 0) this.setLevel(this.level - 1, now);
  }

  private stopVideoLoop(): void {
    window.clearInterval(this.camTimer);
    this.camTimer = undefined;
    if (this.camVideo) this.camVideo.srcObject = null;
    this.camVideo = null;
  }

  /** Copies the camera's current picture to the canvas and encodes it. */
  private sendFrame(): void {
    const video = this.camVideo;
    const canvas = this.camCanvas;
    if (!this.active || !this.camOn || !video || !canvas || video.readyState < 2 || !video.videoWidth) return;
    // the encoder is behind (a slow phone) or the connection is: skip this picture instead of piling up delay.
    // Skipping before encoding keeps the stream whole, so the others' decoders never see a gap.
    const now = performance.now();
    if ((this.vEnc && this.vEnc.encodeQueueSize > 2) || sendBacklog() > VIDEO_BACKLOG) return this.onPressure(now);
    // six clean seconds at this step: try the next one up
    if (this.level < LEVELS.length - 1 && now - this.lastSkip > 6000 && now - this.levelSince > 6000) this.setLevel(this.level + 1, now);
    const step = LEVELS[this.level]!;
    const w = even(Math.min(step.width, video.videoWidth));
    const h = even((video.videoHeight * w) / video.videoWidth);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const c2d = canvas.getContext('2d');
    if (!c2d) return;
    c2d.drawImage(video, 0, 0, w, h);
    const size = `${w}x${h}@${this.level}`;
    if (!this.vEnc || this.vEncSize !== size) {
      this.closeVideo();
      this.vEnc = new VideoEncoder({
        output: (chunk) => this.sendChunk('video', chunk, { seq: this.vSeq++ }),
        error: () => this.closeVideo(),
      });
      this.vEnc.configure({ codec: 'vp8', width: w, height: h, bitrate: step.bitrate, framerate: step.fps, latencyMode: 'realtime' });
      this.vEncSize = size;
      this.vForceKey = true;
    }
    const timestamp = Math.round(performance.now() * 1000);
    const key = this.vForceKey || timestamp - this.lastKeyTs >= KEY_EVERY_US;
    if (key) {
      this.lastKeyTs = timestamp;
      this.vForceKey = false;
    }
    const frame = new VideoFrame(canvas, { timestamp });
    this.vEnc.encode(frame, { keyFrame: key });
    frame.close();
  }

  private sendChunk(kind: 'audio' | 'video', chunk: EncodedAudioChunk | EncodedVideoChunk, extra: { rate?: number; ch?: number; seq?: number }): void {
    const u8 = new Uint8Array(chunk.byteLength);
    chunk.copyTo(u8);
    sendMedia(kind, u8, { key: chunk.type === 'key', ts: chunk.timestamp, seq: extra.seq ?? 0, rate: extra.rate, ch: extra.ch });
  }

  private closeAudio(): void {
    try {
      this.aEnc?.close();
    } catch {
      /* already closed */
    }
    this.aEnc = null;
  }

  private closeVideo(): void {
    try {
      this.vEnc?.close();
    } catch {
      /* already closed */
    }
    this.vEnc = null;
    this.vEncSize = '';
  }

  // ---------------------------------------------------------------- receiving

  private makeRemote(): Remote {
    return {
      audioDec: null,
      audioFormat: '',
      nextTime: 0,
      videoDec: null,
      canvas: null,
      track: null,
      gotKey: false,
      camOn: false,
      lastVideo: 0,
      lastAsk: 0,
      lastSeq: -1,
    };
  }

  private setRemoteCam(id: string, r: Remote, on: boolean): void {
    if (r.camOn === on) return;
    r.camOn = on;
    this.o.onRemoteCam(id, on);
  }

  /** Frames stop when someone turns their camera off, so a camera with no frames for a moment counts as off. */
  private sweep(): void {
    const now = Date.now();
    for (const [id, r] of this.remotes) if (r.camOn && now - r.lastVideo > 2500) this.setRemoteCam(id, r, false);
  }

  private playAudio(r: Remote, c: MediaChunk): void {
    const rate = c.rate || 48000;
    const ch = c.ch || 1;
    const format = `${rate}/${ch}`;
    if (!r.audioDec || r.audioFormat !== format) {
      try {
        r.audioDec?.close();
      } catch {
        /* already closed */
      }
      r.audioDec = new AudioDecoder({
        output: (data) => this.schedule(r, data),
        error: () => {
          r.audioDec = null;
        },
      });
      r.audioDec.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: ch });
      r.audioFormat = format;
    }
    r.audioDec.decode(new EncodedAudioChunk({ type: 'key', timestamp: c.ts, data: c.bytes }));
  }

  /** Plays one decoded piece of sound right after the previous one, with a small cushion against network jitter. */
  private schedule(r: Remote, data: AudioData): void {
    const ctx = this.ctx;
    if (!ctx) return data.close();
    const frames = data.numberOfFrames;
    const buffer = ctx.createBuffer(data.numberOfChannels, frames, data.sampleRate);
    const plane = new Float32Array(frames);
    for (let c = 0; c < data.numberOfChannels; c++) {
      data.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
      buffer.copyToChannel(plane, c);
    }
    data.close();
    const now = ctx.currentTime;
    // fell behind (a network stall) or ran far ahead (a burst): start again close to "now" instead of drifting
    if (r.nextTime < now + 0.02 || r.nextTime > now + 0.3) r.nextTime = now + 0.06;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.start(r.nextTime);
    r.nextTime += buffer.duration;
  }

  private playVideo(id: string, r: Remote, c: MediaChunk): void {
    // the canvas and its track are made once per person; a decoder that fails is replaced, so the tile does not flicker
    if (!r.canvas) {
      const canvas = document.createElement('canvas');
      canvas.width = MAX_WIDTH;
      canvas.height = 360;
      canvas.getContext('2d'); // a canvas needs a context before its stream can be captured
      r.canvas = canvas;
      r.track = canvas.captureStream().getVideoTracks()[0] ?? null;
      if (r.track) this.o.onRemoteVideo(id, r.track);
    }
    if (!r.videoDec) {
      const canvas = r.canvas;
      r.videoDec = new VideoDecoder({
        output: (frame) => {
          if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
            canvas.width = frame.displayWidth;
            canvas.height = frame.displayHeight;
          }
          canvas.getContext('2d')?.drawImage(frame, 0, 0);
          frame.close();
        },
        error: () => {
          // a damaged picture: ask for a key frame now, and start from it
          r.videoDec = null;
          r.gotKey = false;
          this.requestKey(id);
        },
      });
      r.videoDec.configure({ codec: 'vp8', optimizeForLatency: true });
    }
    // frames arriving means their camera is on
    r.lastVideo = Date.now();
    this.setRemoteCam(id, r, true);
    // A chunk went missing (the server skipped some while we were behind), or the decoder itself is behind: what
    // follows would be drawn as a smeared or late picture, so wait for a key frame instead.
    const gap = r.lastSeq >= 0 && c.seq !== r.lastSeq + 1;
    r.lastSeq = c.seq;
    if (!c.key && (gap || r.videoDec.decodeQueueSize > 4)) r.gotKey = false;
    // a decoder can only start from a key frame: until one arrives, ask for one (once every 1.5 s) and wait
    if (!r.gotKey && !c.key) {
      if (Date.now() - r.lastAsk > 1500) this.requestKey(id);
      return;
    }
    r.gotKey = true;
    r.videoDec.decode(new EncodedVideoChunk({ type: c.key ? 'key' : 'delta', timestamp: c.ts, data: c.bytes }));
  }

  private requestKey(id: string): void {
    const r = this.remotes.get(id);
    if (r) r.lastAsk = Date.now();
    send({ t: 'media', kind: 'keyreq', ts: 0, to: id });
  }

  private forget(id: string): void {
    const r = this.remotes.get(id);
    this.remotes.delete(id);
    if (r) {
      try {
        r.audioDec?.close();
      } catch {
        /* already closed */
      }
      try {
        r.videoDec?.close();
      } catch {
        /* already closed */
      }
      r.track?.stop();
    }
    this.o.onRemoteVideo(id, null);
    this.o.onRemoteCam(id, false);
  }
}
