import { useEffect, useRef } from 'react';

export interface PlayerActions {
  toggle(): void;
  seekBy(deltaSeconds: number): void;
  volumeBy(delta: number): void;
  mute(): void;
  fullscreen(): void;
  subtitles(): void;
}

/** Keys that should not trigger player shortcuts because the user is typing or operating a control. */
function ignore(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey) return true;
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable) return true;
  // Space on a focused button already "clicks" it; do not also toggle playback
  return e.key === ' ' && el.tagName === 'BUTTON';
}

/**
 * Player keyboard shortcuts (the same ones people know from YouTube and music players):
 *   Space / K play-pause · ← / J back 5s · → / L forward 5s · ↑ ↓ volume · M mute · F fullscreen · C captions
 * Seeking forward is still clamped by the player, so viewers can never pass the host.
 */
export function usePlayerShortcuts(actions: PlayerActions): void {
  const ref = useRef(actions);
  ref.current = actions;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ignore(e)) return;
      const a = ref.current;
      switch (e.key) {
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          a.toggle();
          break;
        case 'ArrowLeft':
        case 'j':
        case 'J':
          e.preventDefault();
          a.seekBy(-5);
          break;
        case 'ArrowRight':
        case 'l':
        case 'L':
          e.preventDefault();
          a.seekBy(5);
          break;
        case 'ArrowUp':
          e.preventDefault();
          a.volumeBy(10);
          break;
        case 'ArrowDown':
          e.preventDefault();
          a.volumeBy(-10);
          break;
        case 'm':
        case 'M':
          a.mute();
          break;
        case 'f':
        case 'F':
          a.fullscreen();
          break;
        case 'c':
        case 'C':
          a.subtitles();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

/** Lock-screen, notification and headphone/media-key controls (the Media Session API). */
export function useMediaSession(o: {
  title: string;
  playing: boolean;
  /** cover image for the lock screen / notification */
  artwork?: string;
  onPlay(): void;
  onPause(): void;
  onSeekBy(d: number): void;
  /** host only: the lock screen's next / previous song buttons */
  onNext?(): void;
  onPrev?(): void;
}): void {
  const ref = useRef(o);
  ref.current = o;
  const canSkip = !!o.onNext;

  useEffect(() => {
    if (!('mediaSession' in navigator) || !canSkip) return;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        /* this browser does not support that action */
      }
    };
    set('nexttrack', () => ref.current.onNext?.());
    set('previoustrack', () => ref.current.onPrev?.());
    return () => {
      set('nexttrack', null);
      set('previoustrack', null);
    };
  }, [canSkip]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, fn: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* this browser does not support that action */
      }
    };
    set('play', () => ref.current.onPlay());
    set('pause', () => ref.current.onPause());
    set('seekbackward', () => ref.current.onSeekBy(-10));
    set('seekforward', () => ref.current.onSeekBy(10));
    return () => {
      for (const a of ['play', 'pause', 'seekbackward', 'seekforward'] as const) set(a, null);
    };
  }, []);

  useEffect(() => {
    if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: o.title,
      artist: 'Couchline',
      artwork: o.artwork ? [{ src: o.artwork, sizes: '480x360', type: 'image/jpeg' }] : [],
    });
    navigator.mediaSession.playbackState = o.playing ? 'playing' : 'paused';
  }, [o.title, o.playing, o.artwork]);
}
