/* eslint-disable @typescript-eslint/no-explicit-any */
let loading: Promise<any> | null = null;

/** Loads the YouTube IFrame API once and resolves with the global `YT` object. */
export function loadYT(): Promise<any> {
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  loading ??= new Promise((resolve, reject) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(w.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => reject(new Error('Could not load the YouTube player.'));
    document.head.appendChild(s);
  });
  return loading;
}

/** A thin, uniform wrapper so the sync logic does not care which player it drives. */
export interface PlayerApi {
  play(): void;
  pause(): void;
  seek(t: number): void;
  time(): number;
  duration(): number;
  playing(): boolean;
  /** true once playback reached the end (calling play() again would restart it) */
  ended(): boolean;
  setVolume(v: number): void;
  /** playback speed, 1 = normal */
  setRate(r: number): void;
  destroy(): void;
}

export function ytApi(p: any): PlayerApi {
  return {
    play: () => p.playVideo(),
    pause: () => p.pauseVideo(),
    seek: (t) => p.seekTo(t, true),
    time: () => Number(p.getCurrentTime?.()) || 0,
    duration: () => Number(p.getDuration?.()) || 0,
    playing: () => {
      const s = p.getPlayerState?.();
      return s === 1 || s === 3;
    },
    ended: () => p.getPlayerState?.() === 0,
    setVolume: (v) => p.setVolume(v),
    setRate: (r) => p.setPlaybackRate?.(r),
    destroy: () => p.destroy?.(),
  };
}

let shared: HTMLVideoElement | null = null;
/**
 * One <video> for every hosted song, video and file. Phones only let an element play with sound after it was
 * tapped once; a fresh element per track meant tapping play again on every song change.
 */
export function sharedVideo(): HTMLVideoElement {
  if (!shared) {
    shared = document.createElement('video');
    shared.playsInline = true;
    shared.setAttribute('playsinline', '');
    shared.preload = 'auto';
  }
  return shared;
}

export function htmlApi(v: HTMLVideoElement): PlayerApi {
  return {
    // If the browser refuses to start with sound, start muted so the room keeps playing in sync; the page
    // hears about it ('wp-muted-autoplay') and offers a "Tap for sound" button.
    play: () =>
      void v.play().catch((e: Error) => {
        if (e?.name !== 'NotAllowedError' || v.muted) return;
        v.muted = true;
        v.dispatchEvent(new Event('wp-muted-autoplay'));
        void v.play().catch(() => undefined);
      }),
    pause: () => v.pause(),
    seek: (t) => {
      v.currentTime = t;
    },
    time: () => v.currentTime || 0,
    duration: () => (Number.isFinite(v.duration) ? v.duration : 0),
    playing: () => !v.paused && !v.ended,
    ended: () => v.ended,
    setVolume: (x) => {
      v.volume = Math.min(1, Math.max(0, x / 100));
    },
    setRate: (r) => {
      v.playbackRate = r;
    },
    destroy: () => {
      v.pause();
      v.removeAttribute('src');
      v.load();
    },
  };
}
