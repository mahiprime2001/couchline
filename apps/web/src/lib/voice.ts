/**
 * Voice and camera through the room server (no peer-to-peer connections).
 *
 * Each person encodes their own microphone (Opus) and camera (VP8) with WebCodecs and sends the chunks through the
 * room's WebSocket. The server copies each chunk to the other people in voice. Each person decodes what they receive
 * and plays it, through generator tracks that look like ordinary media tracks to the rest of the app.
 *
 * Needs a browser with WebCodecs and insertable streams (Chrome, Edge, and Chrome on Android).
 */
import type { ServerMsg } from '@wp/shared';
import { send } from './room';

type MediaIn = Extract<ServerMsg, { t: 'media' }>;

const CAM = { width: { ideal: 640 }, height: { ideal: 360 }, facingMode: 'user' };
const FPS = 24;
const VIDEO_BITRATE = 500_000;
const AUDIO_BITRATE = 32_000;
const KEY_EVERY_US = 2_000_000; // a key frame every 2 s, so someone who joins late can start watching soon

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
  audioWriter: WritableStreamDefaultWriter<AudioData> | null;
  audioEl: HTMLAudioElement | null;
  audioFormat: string;
  videoDec: VideoDecoder | null;
  videoWriter: WritableStreamDefaultWriter<VideoFrame> | null;
  /** a video decoder waits for a key frame before it can start */
  gotKey: boolean;
  camOn: boolean;
  /** when the last video frame from them arrived (ms) */
  lastVideo: number;
  /** when we last asked them for a key frame (ms) */
  lastAsk: number;
}

// The browser APIs below are not in every TypeScript DOM library, so they are typed here.
type ProcessorCtor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<any> };
type GeneratorCtor = new (init: { kind: 'audio' | 'video' }) => MediaStreamTrack & { writable: WritableStream<any> };

function browserWindow(): { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor } {
  return window as unknown as { MediaStreamTrackProcessor?: ProcessorCtor; MediaStreamTrackGenerator?: GeneratorCtor };
}

/** Throws a clear message on a browser that cannot send or play voice, before the microphone is asked for. */
function assertVoiceSupport(): void {
  const w = browserWindow();
  if (!w.MediaStreamTrackProcessor || !w.MediaStreamTrackGenerator || typeof AudioEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('This browser cannot do voice and video here. Use Chrome or Edge.');
  }
}

function readerOf(track: MediaStreamTrack): ReadableStreamDefaultReader<any> {
  return new (browserWindow().MediaStreamTrackProcessor as ProcessorCtor)({ track }).readable.getReader();
}

function generatorOf(kind: 'audio' | 'video'): MediaStreamTrack & { writable: WritableStream<any> } {
  return new (browserWindow().MediaStreamTrackGenerator as GeneratorCtor)({ kind });
}

function toBase64(u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

export class VoiceManager {
  private active = false;
  private micOn = true;
  private cam: MediaStreamTrack | null = null;
  private mic: MediaStreamTrack | null = null;
  /** the camera is kept open once granted; "off" only stops sending it, so turning it on again never re-asks */
  private camOn = false;
  /** bumped whenever a loop restarts, so an old loop stops itself */
  private camGen = 0;
  private micGen = 0;
  private aEnc: AudioEncoder | null = null;
  private vEnc: VideoEncoder | null = null;
  private aReader: ReadableStreamDefaultReader<any> | null = null;
  private vReader: ReadableStreamDefaultReader<any> | null = null;
  private vForceKey = true;
  private lastKeyTs = -Infinity;
  private remotes = new Map<string, Remote>();
  private sweepTimer: number | undefined;

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
    if (this.mic) this.startAudio(this.mic);
    if (this.cam) this.startVideo(this.cam);
    send({ t: 'media', kind: 'cam', ts: 0, on: this.camOn });
    this.sweepTimer = window.setInterval(() => this.sweep(), 1000);
  }

  leave(): void {
    this.active = false;
    window.clearInterval(this.sweepTimer);
    this.camGen++;
    this.micGen++;
    this.mic?.stop();
    this.cam?.stop();
    this.mic = null;
    this.cam = null;
    this.camOn = false;
    void this.aReader?.cancel().catch(() => undefined);
    void this.vReader?.cancel().catch(() => undefined);
    this.closeAudio();
    this.closeVideo();
    for (const id of [...this.remotes.keys()]) this.forget(id);
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
    if (!this.active) return;
    const want = new Set(voiceIds.filter((id) => id !== this.o.myId));
    for (const id of [...this.remotes.keys()]) if (!want.has(id)) this.forget(id);
  }

  /** An encoded chunk from someone else in voice (the server relays it). */
  handleMedia(m: MediaIn): void {
    if (!this.active || m.from === this.o.myId) return;
    // someone's picture broke on their side: the next frame we send is a key frame they can start from
    if (m.kind === 'keyreq') {
      this.vForceKey = true;
      return;
    }
    const r = this.remotes.get(m.from) ?? this.makeRemote();
    this.remotes.set(m.from, r);
    if (m.kind === 'cam') {
      // an explicit on/off from them; a message sent before they joined voice can be dropped, so frames count too
      this.setRemoteCam(m.from, r, !!m.on);
      return;
    }
    if (!m.data) return;
    const bytes = fromBase64(m.data);
    if (m.kind === 'audio') this.playAudio(r, m, bytes);
    else this.playVideo(m.from, r, m, bytes);
  }

  // ------------------------------------------------------------------ sending

  private startAudio(track: MediaStreamTrack): void {
    const gen = ++this.micGen;
    void this.aReader?.cancel().catch(() => undefined);
    const reader = readerOf(track);
    this.aReader = reader;
    void (async () => {
      try {
        for (;;) {
          const { done, value: frame } = await reader.read();
          if (done || gen !== this.micGen) {
            frame?.close();
            break;
          }
          // muted: nothing is sent, so the others hear silence rather than a quiet hiss
          if (!this.micOn) {
            frame.close();
            continue;
          }
          if (!this.aEnc) {
            const rate = frame.sampleRate;
            const ch = frame.numberOfChannels;
            this.aEnc = new AudioEncoder({
              output: (chunk) => this.sendChunk('audio', chunk, { rate, ch }),
              error: () => this.closeAudio(),
            });
            this.aEnc.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: ch, bitrate: AUDIO_BITRATE });
          }
          this.aEnc.encode(frame);
          frame.close();
        }
      } catch {
        // the microphone went away: stop quietly
      }
    })();
  }

  private startVideo(track: MediaStreamTrack): void {
    const gen = ++this.camGen;
    this.watchCam(track);
    // one reader per camera pipeline: a second loop on the same track would feed the encoder out of order
    void this.vReader?.cancel().catch(() => undefined);
    const reader = readerOf(track);
    this.vReader = reader;
    void (async () => {
      try {
        for (;;) {
          const { done, value: frame } = await reader.read();
          if (done || gen !== this.camGen) {
            frame?.close();
            break;
          }
          if (!this.camOn) {
            frame.close();
            continue;
          }
          if (!this.vEnc) {
            this.vEnc = new VideoEncoder({
              output: (chunk) => this.sendChunk('video', chunk, {}),
              error: () => this.closeVideo(),
            });
            this.vEnc.configure({ codec: 'vp8', width: frame.displayWidth, height: frame.displayHeight, bitrate: VIDEO_BITRATE, framerate: FPS });
          }
          const key = this.vForceKey || frame.timestamp - this.lastKeyTs >= KEY_EVERY_US;
          if (key) {
            this.lastKeyTs = frame.timestamp;
            this.vForceKey = false;
          }
          this.vEnc.encode(frame, { keyFrame: key });
          frame.close();
        }
      } catch {
        // the camera went away: stop quietly
      }
    })();
  }

  private sendChunk(kind: 'audio' | 'video', chunk: EncodedAudioChunk | EncodedVideoChunk, extra: { rate?: number; ch?: number }): void {
    const u8 = new Uint8Array(chunk.byteLength);
    chunk.copyTo(u8);
    send({ t: 'media', kind, ts: chunk.timestamp, key: chunk.type === 'key', data: toBase64(u8), ...extra });
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
  }

  // ---------------------------------------------------------------- receiving

  private makeRemote(): Remote {
    return {
      audioDec: null,
      audioWriter: null,
      audioEl: null,
      audioFormat: '',
      videoDec: null,
      videoWriter: null,
      gotKey: false,
      camOn: false,
      lastVideo: 0,
      lastAsk: 0,
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

  private playAudio(r: Remote, m: MediaIn, bytes: Uint8Array): void {
    const rate = m.rate ?? 48000;
    const ch = m.ch ?? 1;
    const format = `${rate}/${ch}`;
    if (!r.audioDec || r.audioFormat !== format) {
      r.audioDec?.close();
      r.audioWriter?.close().catch(() => undefined);
      const track = generatorOf('audio');
      r.audioWriter = track.writable.getWriter();
      r.audioDec = new AudioDecoder({
        output: (data) => r.audioWriter?.write(data).catch(() => undefined),
        error: () => {
          r.audioDec = null;
        },
      });
      r.audioDec.configure({ codec: 'opus', sampleRate: rate, numberOfChannels: ch });
      r.audioFormat = format;
      if (!r.audioEl) {
        r.audioEl = document.createElement('audio');
        r.audioEl.autoplay = true;
        this.o.container.appendChild(r.audioEl);
      }
      r.audioEl.srcObject = new MediaStream([track]);
    }
    r.audioDec?.decode(new EncodedAudioChunk({ type: 'key', timestamp: m.ts, data: bytes }));
  }

  private playVideo(id: string, r: Remote, m: MediaIn, bytes: Uint8Array): void {
    // the picture track is made once per person; a decoder that fails is replaced inside it, so the tile does not flicker
    if (!r.videoWriter) {
      const track = generatorOf('video');
      r.videoWriter = track.writable.getWriter();
      this.o.onRemoteVideo(id, track);
    }
    if (!r.videoDec) {
      r.videoDec = new VideoDecoder({
        output: (frame) => r.videoWriter?.write(frame).catch(() => undefined),
        error: () => {
          // a damaged picture: ask for a key frame now, and start from it
          r.videoDec = null;
          r.gotKey = false;
          this.requestKey(id);
        },
      });
      r.videoDec.configure({ codec: 'vp8' });
    }
    // frames arriving means their camera is on
    r.lastVideo = Date.now();
    this.setRemoteCam(id, r, true);
    // a decoder can only start from a key frame: until one arrives, ask for one (once every 1.5 s) and wait
    if (!r.gotKey && !m.key) {
      if (Date.now() - r.lastAsk > 1500) this.requestKey(id);
      return;
    }
    r.gotKey = true;
    r.videoDec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: m.ts, data: bytes }));
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
      r.audioWriter?.close().catch(() => undefined);
      r.videoWriter?.close().catch(() => undefined);
      r.audioEl?.remove();
    }
    this.o.onRemoteVideo(id, null);
    this.o.onRemoteCam(id, false);
  }
}
