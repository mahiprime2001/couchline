import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { isTorrentLink, type SyncState } from '@wp/shared';
import { send, useRoom } from './room';

/** YouTube search, playlists and suggestions, served by the Node backend through yt-dlp (no API key). */
export interface YtEntry {
  id: string;
  title: string;
  duration: number | null;
  channel: string | null;
}

export interface YtList {
  title: string;
  entries: YtEntry[];
}

const cache = new Map<string, Promise<YtList>>();

export function fetchYt(kind: 'search' | 'playlist' | 'related', arg: string): Promise<YtList> {
  const param = kind === 'search' ? 'q' : kind === 'playlist' ? 'list' : 'v';
  const key = `${kind}:${arg}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = fetch(`/api/yt/${kind}?${param}=${encodeURIComponent(arg)}`).then(async (r) => {
    const j = (await r.json().catch(() => ({}))) as YtList & { error?: string };
    if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
    return j;
  });
  cache.set(key, p);
  p.catch(() => cache.delete(key));
  return p;
}

/** Ask the server's yt-dlp whether it can play a link: resolves with its title, or fails with yt-dlp's reason. */
export async function checkLink(url: string): Promise<{ title: string }> {
  const r = await fetch(`/api/yt/check?url=${encodeURIComponent(url)}`);
  const j = (await r.json().catch(() => ({}))) as { title?: string; error?: string };
  if (!r.ok) throw new Error(j.error ?? `yt-dlp could not check this link (${r.status}).`);
  return { title: j.title ?? '' };
}

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;
export const thumbUrl = (id: string) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/** the playlist id of a YouTube link (watch?v=..&list=.. or playlist?list=..), if it has one */
export function playlistIdOf(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return null;
    const list = u.searchParams.get('list');
    return list && /^[\w-]{10,64}$/.test(list) ? list : null;
  } catch {
    return null;
  }
}

/** A link to paste (http(s), or a magnet link): it goes in the queue as a link, never to a YouTube search. */
export const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim()) || isTorrentLink(s);

/** The YouTube video behind what the room plays: the embed itself, or a yt-dlp copy (tagged ?yt=<id>). */
export function youtubeIdOf(sync: SyncState): string | null {
  if (sync.kind === 'youtube') return sync.videoId;
  if (sync.kind === 'hls') {
    try {
      const id = new URL(sync.url).searchParams.get('yt');
      return id && /^[\w-]{11}$/.test(id) ? id : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The Node backend's feature level this page was written for (apps/server/src/index.ts, /api/health "api"). */
export const SERVER_API = 3;

interface Health {
  ytdlp: boolean;
  /** the server can search GIFs (it has a Giphy or Tenor key) */
  gifs: boolean;
  /** a Node backend older than this page: it rejects newer messages (queue history, playlists, …) */
  outdated: boolean;
}
let health: Promise<Health> | null = null;
function useHealth(): Health | null {
  const [h, setH] = useState<Health | null>(null);
  useEffect(() => {
    health ??= fetch('/api/health')
      .then((r) => r.json() as Promise<{ backend?: string; api?: number; gifs?: boolean; media?: { ytdlp?: boolean } }>)
      .then((j) => ({ ytdlp: !!j.media?.ytdlp, gifs: !!j.gifs, outdated: j.backend === 'node' && (j.api ?? 0) < SERVER_API }))
      .catch(() => {
        health = null;
        return { ytdlp: false, gifs: false, outdated: false };
      });
    let live = true;
    void health.then((v) => live && setH(v));
    return () => {
      live = false;
    };
  }, []);
  return h;
}

/** whether this server can do YouTube search/playlists/suggestions (the Node backend with yt-dlp) */
export function useYtdlp(): boolean {
  const h = useHealth();
  return !!h && h.ytdlp && !h.outdated;
}

/** whether the chat can search GIFs (the server has a free Giphy or Tenor key) */
export function useGifSearch(): boolean {
  return !!useHealth()?.gifs;
}

/** the page is newer than the running backend (it was not restarted after an update) */
export function useServerOutdated(): boolean {
  return !!useHealth()?.outdated;
}

/** the host's "Autoplay similar videos" switch, remembered in this browser */
export const useAutoplay = create<{ on: boolean; set(on: boolean): void }>((set) => ({
  on: (() => {
    try {
      return localStorage.getItem('wp-autoplay') !== '0';
    } catch {
      return true;
    }
  })(),
  set: (on) => {
    try {
      localStorage.setItem('wp-autoplay', on ? '1' : '0');
    } catch {
      /* private window: just not remembered */
    }
    set({ on });
  },
}));

/**
 * Host only: like YouTube's autoplay. When Up next runs empty during a YouTube video, queue the first
 * suggestion for it that has not played yet. Off while repeat is on (repeat decides what comes next).
 */
export function useAutoplaySuggestions(enabled: boolean): void {
  const sync = useRoom((s) => s.sync);
  const upNext = useRoom((s) => s.queue.filter((q) => q.approved).length);
  const repeat = useRoom((s) => s.repeat);
  const on = useAutoplay((s) => s.on);
  const yt = useYtdlp();
  const nowId = youtubeIdOf(sync);
  // one suggestion per song: if you remove it from Up next, it stays removed until the next song starts
  const doneFor = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled || !on || !yt || !nowId || upNext > 0 || repeat !== 'off' || doneFor.current === nowId) return;
    let live = true;
    fetchYt('related', nowId)
      .then((r) => {
        if (!live) return;
        const played = new Set(useRoom.getState().history.map((h) => h.videoId));
        const next = r.entries.find((e) => e.id !== nowId && !played.has(e.id));
        doneFor.current = nowId;
        if (next) send({ t: 'queueAdd', url: watchUrl(next.id), title: next.title });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [enabled, on, yt, nowId, upNext, repeat]);
}

export function formatDuration(s: number | null): string {
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
