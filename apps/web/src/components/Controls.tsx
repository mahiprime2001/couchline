import { useEffect, useRef, useState } from 'react';
import { formatTime, parseSubtitles, type Cue } from '@wp/shared';

export interface ControlsProps {
  playing: boolean;
  current: number;
  min: number;
  max: number;
  /** viewer is following the live edge */
  atLive: boolean;
  /** show LIVE / Go live affordances */
  liveMode: boolean;
  /** seconds behind live, shown on the Go live button */
  behind: number;
  /** furthest point you may seek to (a viewer cannot pass the host); the bar beyond it is drawn dimmer */
  limit?: number;
  volume: number;
  onToggle(): void;
  onSeek(t: number): void;
  onGoLive(): void;
  onVolume(v: number): void;
  onFullscreen(): void;
  onCues(cues: Cue[] | null): void;
  hasCues: boolean;
  extra?: React.ReactNode;
}

export function Controls(p: ControlsProps) {
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ t: number; x: number } | null>(null);
  const subRef = useRef<HTMLInputElement>(null);
  const span = Math.max(0.1, p.max - p.min);
  const limit = p.limit === undefined ? p.max : Math.min(Math.max(p.limit, p.min), p.max);
  const value = drag ?? Math.min(Math.max(p.current, p.min), p.max);
  const pct = (t: number) => `${((t - p.min) / span) * 100}%`;
  // a YouTube live stream reports days of "duration" (time since it started): show LIVE, not 2094:35:03
  const endless = !p.liveMode && p.max > 48 * 3600;

  // A drag is committed wherever the pointer is let go: off the bar, or when a phone cancels the touch.
  // (Listening on the bar alone left it frozen at the dragged spot whenever the release happened elsewhere.)
  const dragRef = useRef<number | null>(null);
  const latest = useRef({ onSeek: p.onSeek, limit });
  latest.current = { onSeek: p.onSeek, limit };
  const commit = () => {
    const t = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (t !== null) latest.current.onSeek(Math.min(t, latest.current.limit));
  };
  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const end = () => commit();
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('touchend', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('touchend', end);
    };
  }, [dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  // hovering the bar shows the time under the pointer, like YouTube
  const onHover = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
    setHover({ x, t: p.min + (x / Math.max(1, r.width)) * span });
  };

  const loadSubs = async (file: File | undefined) => {
    if (!file) return;
    p.onCues(parseSubtitles(await file.text()));
  };

  return (
    <div className="controls" onClick={(e) => e.stopPropagation()}>
      <div className="seek-wrap" onPointerMove={onHover} onPointerLeave={() => setHover(null)}>
        <input
          className="seek"
          type="range"
          min={p.min}
          max={p.max}
          step={0.1}
          value={value}
          aria-label="Seek"
          aria-valuetext={`${formatTime(value - p.min)} of ${formatTime(p.max - p.min)}`}
          style={{ ['--pct' as string]: pct(value), ['--lim' as string]: pct(limit) }}
          onChange={(e) => {
            const t = Number(e.target.value);
            dragRef.current = t;
            setDrag(t);
          }}
          onKeyUp={commit}
        />
        {hover && (
          <span className="seek-tip" style={{ left: hover.x }} aria-hidden>
            {formatTime(Math.max(0, hover.t - (p.liveMode ? p.min : 0)))}
            {hover.t > limit + 0.5 ? ' · not yet' : ''}
          </span>
        )}
      </div>
      <div className="controls-row">
        <button className="icon" onClick={p.onToggle} aria-label={p.playing ? 'Pause' : 'Play'}>
          {p.playing ? '⏸' : '▶'}
        </button>
        {endless ? (
          <span className="live-badge">● LIVE</span>
        ) : (
          <span className="time">
            {formatTime(value - (p.liveMode ? p.min : 0))} / {formatTime(p.max - (p.liveMode ? p.min : 0))}
          </span>
        )}
        {p.liveMode &&
          (p.atLive ? (
            <span className="live-badge">● LIVE</span>
          ) : (
            <button className="golive" onClick={p.onGoLive}>
              Go live{p.behind > 1 ? ` · −${formatTime(p.behind)}` : ''}
            </button>
          ))}
        <span className="spacer" />
        {p.extra}
        <label className="vol" title="Volume">
          🔊
          <input
            type="range"
            min={0}
            max={100}
            value={p.volume}
            aria-label="Volume"
            onChange={(e) => p.onVolume(Number(e.target.value))}
          />
        </label>
        <input ref={subRef} type="file" accept=".srt,.vtt" hidden onChange={(e) => void loadSubs(e.target.files?.[0])} />
        <button
          className={`icon ${p.hasCues ? 'on' : ''}`}
          title={p.hasCues ? 'Remove subtitles' : 'Load subtitles (.srt / .vtt)'}
          onClick={() => (p.hasCues ? p.onCues(null) : subRef.current?.click())}
        >
          CC
        </button>
        <button className="icon" title="Fullscreen" onClick={p.onFullscreen}>
          ⛶
        </button>
      </div>
    </div>
  );
}

/** Subtitles are local to each viewer: they load their own file. */
export function SubtitleOverlay({ cues, time }: { cues: Cue[] | null; time: number }) {
  if (!cues) return null;
  const cue = cues.find((c) => time >= c.start && time <= c.end);
  if (!cue) return null;
  return (
    <div className="subtitle">
      {cue.text.split('\n').map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

/** Shows something for a moment after the pointer moves or the screen is tapped, then hides it again. */
export function useWake(ms = 2500): [boolean, () => void] {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const wake = () => {
    setShown(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(false), ms);
  };
  return [shown, wake];
}

/** Big play/pause and 5-second skip buttons in the middle of the picture, like a phone video player. */
export function TapControls({
  shown,
  playing,
  onToggle,
  onSeekBy,
  onWake,
  onFullscreen,
}: {
  shown: boolean;
  playing: boolean;
  onToggle(): void;
  onSeekBy(d: number): void;
  onWake(): void;
  /** a mouse double-click on the buttons still toggles fullscreen, as anywhere else on the picture */
  onFullscreen?(): void;
}) {
  const lastPointer = useRef('mouse');
  const act = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
    onWake();
  };
  return (
    // On a phone a quick "tap to show, tap play" counts as a double-tap: that must not go fullscreen.
    // With a mouse, double-clicking the middle of the picture (where the buttons are) still should.
    <div
      className={`tap-controls${shown ? ' shown' : ''}`}
      aria-hidden={!shown}
      onPointerDown={(e) => {
        lastPointer.current = e.pointerType;
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (lastPointer.current === 'mouse') onFullscreen?.();
      }}
    >
      <button className="tap-btn" aria-label="Back 5 seconds" title="Back 5 seconds" onClick={act(() => onSeekBy(-5))}>
        <SkipIcon back />
      </button>
      <button className="tap-btn big" aria-label={playing ? 'Pause video' : 'Play video'} onClick={act(onToggle)}>
        <svg viewBox="0 0 24 24" aria-hidden>
          <path fill="currentColor" d={playing ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z'} />
        </svg>
      </button>
      <button className="tap-btn" aria-label="Forward 5 seconds" title="Forward 5 seconds" onClick={act(() => onSeekBy(5))}>
        <SkipIcon />
      </button>
    </div>
  );
}

/** A circular arrow with "5" inside: anticlockwise to go back, mirrored to go forward. */
function SkipIcon({ back }: { back?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <g transform={back ? undefined : 'matrix(-1 0 0 1 24 0)'}>
        <path fill="currentColor" d="M12 5V1.5L7 6l5 4.5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" />
      </g>
      <text x="12" y="16.2" textAnchor="middle" fontSize="7" fontWeight="700" fill="currentColor" fontFamily="system-ui, sans-serif">
        5
      </text>
    </svg>
  );
}
