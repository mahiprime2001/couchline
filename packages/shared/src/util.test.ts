import { describe, expect, it } from 'vitest';
import {
  ClientMsg,
  clampSeek,
  computePosition,
  filterText,
  findCluster,
  formatTime,
  parseLink,
  parseSubtitles,
  roomPhase,
  sortQueue,
  type QueueItem,
  type StreamInfo,
  type SyncState,
} from './index';

const sync = (p: Partial<SyncState> = {}): SyncState => ({
  mode: 'link',
  url: 'u',
  kind: 'file',
  videoId: null,
  playing: true,
  position: 10,
  updatedAt: 1_000,
  ...p,
});
const stream = (p: Partial<StreamInfo> = {}): StreamInfo => ({
  live: false,
  fileName: '',
  fileSize: 0,
  lastPosition: 0,
  source: 'file',
  epoch: 0,
  ...p,
});

describe('computePosition', () => {
  it('advances while playing', () => expect(computePosition(sync(), 4_000)).toBe(13));
  it('is frozen while paused', () => expect(computePosition(sync({ playing: false }), 99_000)).toBe(10));
  it('never goes backwards on clock skew', () => expect(computePosition(sync(), 500)).toBe(10));
});

describe('clampSeek (rewind only, never ahead of live)', () => {
  it('allows going back', () => expect(clampSeek(5, 0, 20)).toBe(5));
  it('blocks going forward past live', () => expect(clampSeek(25, 0, 20)).toBe(20));
  it('blocks before the buffer start', () => expect(clampSeek(-3, 2, 20)).toBe(2));
  it('falls back to live on NaN', () => expect(clampSeek(NaN, 0, 20)).toBe(20));
});

describe('roomPhase', () => {
  it('link/idle rooms are LINK_ACTIVE', () => {
    expect(roomPhase(sync(), stream())).toBe('LINK_ACTIVE');
    expect(roomPhase(sync({ mode: 'idle' }), stream())).toBe('LINK_ACTIVE');
  });
  it('stream rooms depend on the host being live', () => {
    expect(roomPhase(sync({ mode: 'stream' }), stream({ live: true }))).toBe('STREAM_LIVE');
    expect(roomPhase(sync({ mode: 'stream' }), stream({ live: false }))).toBe('STREAM_HOST_AWAY');
  });
});

describe('parseLink', () => {
  it('parses youtube variants', () => {
    for (const u of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=3',
      'https://www.youtube.com/embed/dQw4w9WgXcQ',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ]) {
      const r = parseLink(u);
      expect(r.ok && r.kind === 'youtube' && r.videoId).toBe('dQw4w9WgXcQ');
    }
  });
  it('accepts https video files', () => {
    const r = parseLink('https://example.com/a/b.MP4?x=1');
    expect(r.ok && r.kind).toBe('file');
  });
  it('accepts HLS (.m3u8) streams, including the server-hosted ones', () => {
    const r = parseLink('https://example.com/media/abc/index.m3u8');
    expect(r.ok && r.kind).toBe('hls');
    const local = parseLink('http://localhost:8787/media/abc/index.m3u8');
    expect(local.ok && local.kind).toBe('hls');
  });
  it('rejects everything else', () => {
    expect(parseLink('not a url').ok).toBe(false);
    expect(parseLink('http://example.com/a.mp4').ok).toBe(false);
    expect(parseLink('https://some.example/page')).toMatchObject({ ok: true, kind: 'site' }); // checked by yt-dlp later
    expect(parseLink('javascript:alert(1)').ok).toBe(false);
    expect(parseLink('magnet:?dn=no-hash')).toMatchObject({ ok: false });
    const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=film';
    expect(parseLink(magnet)).toMatchObject({ ok: true, kind: 'site', url: magnet });
    expect(parseLink('https://example.com/films/a.torrent')).toMatchObject({ ok: true, kind: 'site' });
    expect(parseLink('https://www.youtube.com/watch?v=short').ok).toBe(false);
  });
  it('allows http on localhost for testing', () => {
    expect(parseLink('http://localhost:8080/x.mp4').ok).toBe(true);
  });
  it('allows http on private-network addresses but never on public ones', () => {
    expect(parseLink('http://192.168.29.97:8787/media/a/index.m3u8').ok).toBe(true);
    expect(parseLink('http://10.0.0.5/x.mp4').ok).toBe(true);
    expect(parseLink('http://172.20.1.1/x.mp4').ok).toBe(true);
    expect(parseLink('http://172.32.1.1/x.mp4').ok).toBe(false);
    expect(parseLink('http://8.8.8.8/x.mp4').ok).toBe(false);
    expect(parseLink('http://example.com/x.mp4').ok).toBe(false);
  });
});

describe('findCluster', () => {
  const id = [0x1f, 0x43, 0xb6, 0x75];
  const buf = new Uint8Array([0, 1, ...id, 9, 9, ...id, 7]);
  it('finds first and last cluster ids', () => {
    expect(findCluster(buf)).toBe(2);
    expect(findCluster(buf, true)).toBe(8);
  });
  it('returns -1 when absent', () => expect(findCluster(new Uint8Array([1, 2, 3, 4, 5]))).toBe(-1));
});

describe('misc', () => {
  it('formats time', () => {
    expect(formatTime(65)).toBe('1:05');
    expect(formatTime(3725)).toBe('1:02:05');
    expect(formatTime(-4)).toBe('0:00');
  });
  it('masks profanity', () => expect(filterText('well shit')).toBe('well ****'));
  it('sorts queue by votes, stable', () => {
    const q = (id: string, v: number): QueueItem => ({ id, url: '', kind: 'file', videoId: null, by: '', byId: '', votes: Array(v).fill('x'), approved: true });
    expect(sortQueue([q('a', 0), q('b', 2), q('c', 2), q('d', 1)]).map((x) => x.id)).toEqual(['b', 'c', 'd', 'a']);
  });
  it('parses srt and vtt', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nBye';
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello there' },
      { start: 3, end: 4, text: 'Bye' },
    ]);
    const vtt = 'WEBVTT\n\n00:05.000 --> 00:06.000\nShort form';
    expect(parseSubtitles(vtt)).toEqual([{ start: 5, end: 6, text: 'Short form' }]);
  });
});

describe('ClientMsg validation', () => {
  it('rejects bad messages', () => {
    expect(ClientMsg.safeParse({ t: 'control', action: 'seek', position: -1 }).success).toBe(false);
    expect(ClientMsg.safeParse({ t: 'reaction', emoji: '💩' }).success).toBe(false);
    expect(ClientMsg.safeParse({ t: 'pollCreate', question: 'q', options: ['only one'] }).success).toBe(false);
    expect(ClientMsg.safeParse({ t: 'nope' }).success).toBe(false);
  });
  it('accepts good ones', () => {
    expect(ClientMsg.safeParse({ t: 'control', action: 'play', position: 3.2 }).success).toBe(true);
    expect(ClientMsg.safeParse({ t: 'signal', to: 'abc', data: { kind: 'x' } }).success).toBe(true);
  });
});
