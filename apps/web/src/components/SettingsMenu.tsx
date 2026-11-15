import { useEffect, useRef, useState } from 'react';

interface Props {
  /** video qualities offered by the stream, highest first; `index` is the player's level number */
  qualities: Array<{ label: string; index: number }>;
  /** -1 = automatic */
  quality: number;
  /** the height automatic mode currently picked, e.g. "720p" */
  autoLabel: string;
  onQuality(index: number): void;

  audio: Array<{ name: string }>;
  audioIdx: number;
  onAudio(i: number): void;

  subs: Array<{ name: string }>;
  /** -1 = off */
  subIdx: number;
  onSub(i: number): void;

  speed: number;
  onSpeed(s: number): void;
  /** only viewers can change speed (changing it detaches them from the live position) */
  speedEnabled: boolean;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** ⚙️ menu in the player controls: quality, audio track, subtitles, playback speed. Shows only what applies. */
export function SettingsMenu(p: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('touchstart', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const hasQuality = p.qualities.length > 1;
  const hasAudio = p.audio.length > 1;
  const hasSubs = p.subs.length > 0;
  // The gear is always shown, so it is never "missing": with nothing to choose, the menu says why.

  const row = (checked: boolean, label: string, onClick: () => void, key: string | number, disabled = false) => (
    <button
      key={key}
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`opt-row ${checked ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => {
        onClick();
        setOpen(false); // a choice was made: close the menu
      }}
    >
      <span className="tick">{checked ? '✓' : ''}</span>
      {label}
    </button>
  );

  return (
    <div className="menu-wrap" ref={wrap}>
      <button className="icon" type="button" aria-label="Settings" aria-haspopup="menu" aria-expanded={open} title="Quality, audio, subtitles, speed" onClick={() => setOpen((o) => !o)}>
        ⚙️
      </button>
      {open && (
        <div className="settings-menu" role="menu">
          {hasQuality && (
            <section>
              <h5>Quality</h5>
              {row(p.quality === -1, `Auto${p.autoLabel && p.quality === -1 ? ` (${p.autoLabel})` : ''}`, () => p.onQuality(-1), 'auto')}
              {p.qualities.map((q) => row(p.quality === q.index, q.label, () => p.onQuality(q.index), q.index))}
            </section>
          )}
          {hasAudio && (
            <section>
              <h5>Audio</h5>
              {p.audio.map((a, i) => row(p.audioIdx === i, a.name, () => p.onAudio(i), i))}
            </section>
          )}
          {hasSubs && (
            <section>
              <h5>Subtitles</h5>
              {row(p.subIdx === -1, 'Off', () => p.onSub(-1), 'off')}
              {p.subs.map((s, i) => row(p.subIdx === i, s.name, () => p.onSub(i), i))}
            </section>
          )}
          {p.speedEnabled && (
            <section>
              <h5>Speed</h5>
              <div className="speed-row">
                {SPEEDS.map((s) => (
                  <button key={s} type="button" role="menuitemradio" aria-checked={p.speed === s} className={`chipbtn ${p.speed === s ? 'on' : ''}`} onClick={() => { p.onSpeed(s); setOpen(false); }}>
                    {s === 1 ? 'Normal' : `${s}×`}
                  </button>
                ))}
              </div>
              <p className="muted small">Changing speed puts you on your own timeline. “Go live” returns you to the host.</p>
            </section>
          )}
          {!hasQuality && !hasAudio && !hasSubs && (
            <section>
              <p className="muted small">
                Quality, audio tracks and subtitles appear here for videos hosted with ☁️ Upload &amp; host.
                {!p.speedEnabled && ' Playback speed is for viewers, so the room stays in step.'}
              </p>
            </section>
          )}
          <section>
            <p className="muted small">Keys: Space play/pause · ←/→ seek · ↑/↓ volume · M mute · F fullscreen · C subtitles</p>
          </section>
        </div>
      )}
    </div>
  );
}
