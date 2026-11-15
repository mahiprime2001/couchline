// YouTube lists through yt-dlp, without downloading any video: search results, every video of a playlist,
// and suggestions for a video (YouTube's own "Mix" for it, the radio list YouTube would autoplay next).
// No API key needed. Results are cached for a while, so opening the Queue tab again is instant.
import { execFile } from 'node:child_process';

export interface YtEntry {
  id: string;
  title: string;
  /** seconds, when YouTube says */
  duration: number | null;
  channel: string | null;
}

export interface YtList {
  title: string;
  entries: YtEntry[];
}

const TTL_MS = 30 * 60_000;
const VIDEO_ID = /^[\w-]{11}$/;

export function createYt(bin: string) {
  const cache = new Map<string, { at: number; list: Promise<YtList> }>();

  /** `target` is a URL or a yt-dlp search like "ytsearch20:some song" */
  function flat(target: string, limit: number): Promise<YtList> {
    const hit = cache.get(target);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.list;
    if (cache.size > 500) cache.clear();
    const list = new Promise<YtList>((resolve, reject) => {
      execFile(
        bin,
        ['--flat-playlist', '-J', '--playlist-end', String(limit), '--no-warnings', '--', target],
        { timeout: 60_000, maxBuffer: 50_000_000, windowsHide: true },
        (err, stdout) => {
          if (err) return reject(err);
          try {
            interface Raw {
              id?: string;
              title?: string;
              duration?: number;
              channel?: string;
              uploader?: string;
            }
            const j = JSON.parse(stdout) as { title?: string; entries?: Raw[] };
            resolve({
              title: j.title ?? '',
              entries: (j.entries ?? [])
                .filter((e) => e.id && VIDEO_ID.test(e.id))
                .map((e) => ({ id: e.id!, title: e.title ?? e.id!, duration: e.duration ?? null, channel: e.channel ?? e.uploader ?? null })),
            });
          } catch (e) {
            reject(e as Error);
          }
        },
      );
    });
    cache.set(target, { at: Date.now(), list });
    list.catch(() => cache.delete(target)); // do not remember failures
    return list;
  }

  const search = (query: string) => flat(`ytsearch25:${query}`, 25);

  /**
   * Videos like this one: YouTube's Mix for it when yt-dlp can still list Mixes, otherwise a search for the
   * video's own title (yt-dlp hands back at least the title even when the Mix itself is not listable).
   */
  async function related(videoId: string): Promise<YtList> {
    const mix = await flat(`https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`, 26);
    let entries = mix.entries.filter((e) => e.id !== videoId);
    if (entries.length === 0 && mix.title) entries = (await search(mix.title)).entries.filter((e) => e.id !== videoId);
    return { title: mix.title, entries: entries.slice(0, 25) };
  }

  /** Ask yt-dlp (without downloading) whether it can use a link: its title, or yt-dlp's own reason why not. */
  const checks = new Map<string, Promise<{ title: string }>>();
  function check(link: string): Promise<{ title: string }> {
    const hit = checks.get(link);
    if (hit) return hit;
    const p = new Promise<{ title: string }>((resolve, reject) => {
      // -f: yt-dlp must also find a format it can download, so DRM-only pages are refused here, not after loading
      execFile(bin, ['--simulate', '-J', '--flat-playlist', '--playlist-end', '1', '-f', 'bv*+ba/b/ba', '--no-warnings', '--', link], { timeout: 45_000, maxBuffer: 20_000_000, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const why = String(stderr).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ERROR')).pop();
          return reject(new Error((why ?? 'yt-dlp cannot play this link.').replace(/^ERROR:\s*/, '')));
        }
        try {
          resolve({ title: (JSON.parse(stdout) as { title?: string }).title ?? '' });
        } catch {
          reject(new Error('yt-dlp cannot play this link.'));
        }
      });
    });
    checks.set(link, p);
    p.catch(() => undefined).finally(() => setTimeout(() => checks.delete(link), 10 * 60_000));
    if (checks.size > 300) checks.clear();
    return p;
  }

  return {
    check,
    search,
    /** every video of a playlist, album or music playlist (up to 200) */
    playlist: (listId: string) =>
      // "RD..." lists are Mixes, which only open from a watch page (and fall back like `related`)
      listId.startsWith('RD') && VIDEO_ID.test(listId.slice(2)) ? related(listId.slice(2)) : flat(`https://www.youtube.com/playlist?list=${listId}`, 200),
    /** what YouTube would play after this video, without the video itself */
    related,
  };
}
