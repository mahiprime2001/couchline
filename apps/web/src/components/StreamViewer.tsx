import { useEffect, useRef, useState } from 'react';
import { clampSeek, type Cue } from '@wp/shared';
import { onSeekRequest, onSignal, onStreamPiece, send, useRoom } from '../lib/room';
import { StreamReceiver, type RecvStatus } from '../lib/streamReceiver';
import { Controls, SubtitleOverlay, TapControls, useWake } from './Controls';
import { useMediaSession, usePlayerShortcuts } from '../lib/shortcuts';
import { SettingsMenu } from './SettingsMenu';

interface Props {
  onFullscreen(): void;
}

/**
 * How far behind the newest data a following viewer plays. The stream arrives in half-second chunks, plus network
 * jitter: playing right at the edge runs out of picture before the next chunk lands, which shows as a short stop
 * every second. A small cushion keeps playback continuous.
 */
const LIVE_DELAY = 2;

/**
 * Viewer for a host-streamed video. The viewer can rewind inside whatever they have
 * buffered, but every seek is clamped to the live edge: they can never go forward of the host.
 */
export function StreamViewer({ onFullscreen }: Props) {
  const stream = useRoom((s) => s.stream);
  const hostId = useRoom((s) => s.members.find((m) => m.role === 'host')?.id ?? null);
  // the stream arrives through the room server, so only playing WebM matters here
  const supported = typeof MediaSource !== 'undefined';

  const videoRef = useRef<HTMLVideoElement>(null);
  const recvRef = useRef<StreamReceiver | null>(null);
  const hostRef = useRef<string | null>(hostId);
  hostRef.current = hostId;
  // the host's own player is paused (the picture is frozen at the live edge, nothing is wrong)
  const hostPaused = useRoom((s) => s.stream.live && !s.sync.playing);
  const hostPausedRef = useRef(false);
  hostPausedRef.current = hostPaused;
  const [stalled, setStalled] = useState(false);
  const [noAudio, setNoAudio] = useState(false);
  const [speed, setSpeed] = useState(1);
  const speedRef = useRef(1);
  speedRef.current = speed;
  /** waiting for the cushion to fill before playing (at the start, and after the picture ran out) */
  const fillingRef = useRef(true);
  const lastMove = useRef({ t: 0, at: Date.now() });

  const [status, setStatus] = useState<RecvStatus>('idle');
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const [cur, setCur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [attached, setAttached] = useState(true);
  const attachedRef = useRef(true);
  const setAtt = (v: boolean) => {
    attachedRef.current = v;
    setAttached(v);
  };
  const [needTap, setNeedTap] = useState(false);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('wp-volume') ?? 80));
  const [cues, setCues] = useState<Cue[] | null>(null);
  const [ready, setReady] = useState(false);
  const [tapShown, wakeTap] = useWake();

  // the receiver: setup messages from the host, and the stream's pieces relayed by the room server
  useEffect(() => {
    if (!supported || !videoRef.current) return;
    const recv = new StreamReceiver({
      video: videoRef.current,
      signal: (to, data) => send({ t: 'signal', to, data }),
      onStatus: setStatus,
    });
    recvRef.current = recv;
    setReady(true);
    const offSignal = onSignal((from, data) => {
      if (typeof data?.kind === 'string' && data.kind.startsWith('stream-') && from === hostRef.current) recv.handleSignal(data);
    });
    const offPiece = onStreamPiece((p) => recv.handlePiece(p));
    return () => {
      offSignal();
      offPiece();
      recv.destroy();
      recvRef.current = null;
    };
  }, [supported]);

  // (re)connect whenever the host starts streaming again
  useEffect(() => {
    if (!ready) return;
    recvRef.current?.setHost(stream.live ? hostId : null);
  }, [ready, stream.live, stream.epoch, hostId]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100;
    localStorage.setItem('wp-volume', String(volume));
  }, [volume]);

  // follow the live edge, enforce the no-forward rule
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const guard = () => {
      const r = recvRef.current?.range();
      if (!r) return;
      if (v.currentTime > r.end + 0.25) v.currentTime = r.end;
      // any seek that lands well behind the edge (our slider, media keys, PiP...) means "I'm rewinding"
      else if (r.end - v.currentTime > LIVE_DELAY + 2.5) {
        attachedRef.current = false;
        setAttached(false);
      }
    };
    v.addEventListener('seeking', guard);
    const id = window.setInterval(() => {
      const r = recvRef.current?.range() ?? null;
      setRange(r);
      setCur(v.currentTime);
      setPlaying(!v.paused);
      // playing but the picture is not moving for a while: say so instead of silently freezing
      if (Math.abs(v.currentTime - lastMove.current.t) > 0.05 || v.paused) lastMove.current = { t: v.currentTime, at: Date.now() };
      setStalled((!v.paused && Date.now() - lastMove.current.at > 2500) || fillingRef.current);
      setNoAudio(recvRef.current?.hasAudio() === false);
      if (!r) return;
      if (v.currentTime > r.end + 0.25) v.currentTime = r.end;
      if (hostPausedRef.current && r.end - v.currentTime < 0.35) {
        // caught up with a paused host: rest on the last frame rather than spinning on it
        if (!v.paused) v.pause();
        if (!attachedRef.current) {
          attachedRef.current = true;
          setAttached(true);
        }
      } else if (attachedRef.current) {
        const behind = r.end - v.currentTime;
        // Just started, or about to run out (the network stalled, the host just resumed): wait once until most of
        // the cushion is there, instead of playing on an empty buffer and stopping again and again.
        if (!fillingRef.current && behind < 0.25) fillingRef.current = true;
        if (fillingRef.current && behind >= LIVE_DELAY * 0.8) fillingRef.current = false;
        if (fillingRef.current) {
          if (!v.paused) v.pause();
          return;
        }
        if (behind > LIVE_DELAY + 6) {
          // far behind (a long stall): jump back to the cushion
          v.currentTime = Math.max(r.start, r.end - LIVE_DELAY);
        } else if (speedRef.current === 1) {
          // a little behind or ahead of the cushion: drift back gently instead of jumping (a jump skips picture)
          const rate = behind > LIVE_DELAY + 1 ? 1.08 : behind < LIVE_DELAY - 1 ? 0.94 : 1;
          if (v.playbackRate !== rate) v.playbackRate = rate;
        }
        if (v.paused) {
          v.play()
            .then(() => setNeedTap(false))
            .catch(() => setNeedTap(true));
        }
      }
    }, 300);
    return () => {
      v.removeEventListener('seeking', guard);
      window.clearInterval(id);
    };
  }, []);

  // tell the host how far behind we are
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = recvRef.current?.range();
      const v = videoRef.current;
      if (r && v) recvRef.current?.sendLag(r.end - v.currentTime);
    }, 2000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(
    () =>
      onSeekRequest(() => {
        /* timestamps from chat are not meaningful on a per-viewer stream timeline */
      }),
    [],
  );

  const edge = range?.end ?? 0;
  const start = range?.start ?? 0;

  const toggle = () => {
    const v = videoRef.current;
    if (!v) return;
    if (!v.paused) {
      v.pause();
      setAtt(false);
    } else {
      void v.play().catch(() => setNeedTap(true));
    }
  };
  const seek = (t: number) => {
    const v = videoRef.current;
    if (!v || !range) return;
    const target = clampSeek(t, range.start, range.end);
    v.currentTime = target;
    setAtt(range.end - target < LIVE_DELAY + 1);
  };
  const goLive = () => {
    const v = videoRef.current;
    if (!v || !range) return;
    v.currentTime = Math.max(range.start, range.end - LIVE_DELAY);
    v.playbackRate = 1; // back at the live edge means normal speed
    setSpeed(1);
    setAtt(true);
    void v.play().catch(() => setNeedTap(true));
  };
  const tap = () => {
    setNeedTap(false);
    setAtt(true);
    goLive();
  };

  const pickSpeed = (s: number) => {
    if (videoRef.current) videoRef.current.playbackRate = s;
    setSpeed(s);
    if (s !== 1) setAtt(false); // a different speed means you are no longer following the live edge
  };

  // keyboard shortcuts and lock-screen controls (forward seeks are clamped to the live edge by seek())
  const seekBy = (d: number) => seek(cur + d);
  const preMute = useRef(80);
  usePlayerShortcuts({
    toggle,
    seekBy,
    volumeBy: (d) => setVolume((v) => Math.min(100, Math.max(0, v + d))),
    mute: () => setVolume((v) => (v > 0 ? ((preMute.current = v), 0) : preMute.current || 80)),
    fullscreen: onFullscreen,
    subtitles: () => setCues(null),
  });
  useMediaSession({ title: 'Live stream', playing, onPlay: () => !playing && toggle(), onPause: () => playing && toggle(), onSeekBy: seekBy });

  let banner: string | null = null;
  if (!supported) banner = 'This browser cannot play host-streamed video. Use a recent Chrome, Edge or Brave, or ask the host to use Convert on the server (it plays on every device).';
  else if (!stream.live) banner = range ? 'Host disconnected. Waiting for them to return… You can still rewind what you have.' : 'Waiting for the host to start streaming…';
  else if (status === 'full') banner = 'This stream is full (the host limits how many people can watch directly).';
  else if (status === 'error') banner = 'This browser cannot play the host\'s stream (its picture or sound format). Ask the host to use Convert on the server, which plays on every device.';
  else if (status === 'requesting' || status === 'connecting') banner = range ? 'Reconnecting to the host…' : 'Connecting to the host…';
  else if (status === 'lost') banner = 'Connection to the host lost. Retrying…';

  return (
    <div className="stage-inner">
      {/* double-click anywhere on the picture (buttons included, like YouTube) toggles fullscreen */}
      <div className="video-area" onDoubleClick={onFullscreen}>
        <video ref={videoRef} playsInline />
        <div className="shield" onPointerMove={wakeTap} onClick={wakeTap} title="Double-click for fullscreen" />
        <TapControls shown={tapShown} playing={playing} onToggle={toggle} onSeekBy={(d) => seek(cur + d)} onWake={wakeTap} onFullscreen={onFullscreen} />
        <SubtitleOverlay cues={cues} time={cur} />
        {banner && <div className="overlay-msg">{banner}</div>}
        {!banner && hostPaused && (
          <div className="host-paused">⏸ Host paused the video{range ? '' : '. You will see it as soon as they press play.'}</div>
        )}
        {!banner && !hostPaused && stalled && <div className="host-paused">Waiting for the stream…</div>}
        {!banner && noAudio && (
          <div className="host-paused" style={{ top: 56 }}>
            🔇 This stream has no sound: the host's video or screen share has no audio
          </div>
        )}
        {needTap && !banner && (
          <button className="overlay-btn" onClick={tap}>
            ▶ Click to start playback
          </button>
        )}
      </div>
      <Controls
        playing={playing}
        current={cur}
        min={start}
        max={Math.max(edge, start + 0.1)}
        atLive={attached && stream.live}
        liveMode
        behind={Math.max(0, edge - cur)}
        volume={volume}
        onToggle={toggle}
        onSeek={seek}
        onGoLive={goLive}
        onVolume={setVolume}
        onFullscreen={onFullscreen}
        onCues={setCues}
        hasCues={cues !== null}
        extra={
          <SettingsMenu
            qualities={[]}
            quality={-1}
            autoLabel=""
            onQuality={() => undefined}
            audio={[]}
            audioIdx={0}
            onAudio={() => undefined}
            subs={[]}
            subIdx={-1}
            onSub={() => undefined}
            speed={speed}
            onSpeed={pickSpeed}
            speedEnabled
          />
        }
      />
    </div>
  );
}
