import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { REACTIONS, canControlPlayback, formatTime, parseLink, type Member, type QueueItem } from '@wp/shared';
import { requestSeek, send, useRoom } from '../lib/room';
import { useToast } from '../lib/toast';
import { checkLink, fetchYt, formatDuration, useGifSearch, looksLikeUrl, playlistIdOf, thumbUrl, useAutoplay, useYtdlp, watchUrl, youtubeIdOf, type YtEntry } from '../lib/ytlists';
import { ACCENTS, getAccent, getTheme, saveTheme, type Theme } from '../lib/theme';

/** Host and organizers: moderation, polls and repeat. Playback and the queue use canControlPlayback instead. */
const isOrganizer = (m: Member | null) => m?.role === 'host' || m?.role === 'mod';
const TS = /(\b\d{1,2}:\d{2}(?::\d{2})?\b)/g;

function toSeconds(s: string): number {
  return s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
}

// -------------------------------------------------------------------- chat

/** A chat message that is a shared picture: "[image] <url>" (our own upload, or an https image/GIF link). */
const IMAGE_MSG = /^\[image\] (\/chat-image\/[0-9a-f-]{36}|https:\/\/\S+\.(?:gif|png|jpe?g|webp)(?:\?\S*)?)$/i;

export function ChatPanel() {
  const chat = useRoom((s) => s.chat);
  const code = useRoom((s) => s.code);
  const [menu, setMenu] = useState(false);
  const [mode, setMode] = useState<null | 'poll' | 'gif'>(null);
  const [gifLink, setGifLink] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const gifsOn = useGifSearch();
  const [gifQ, setGifQ] = useState('');
  const [gifs, setGifs] = useState<Array<{ preview: string; url: string; title: string }>>([]);
  // GIF picker: trending when the box is empty, otherwise a search a moment after typing stops
  useEffect(() => {
    if (mode !== 'gif' || !gifsOn) return;
    let live = true;
    const t = window.setTimeout(() => {
      fetch(`/api/gif/search?q=${encodeURIComponent(gifQ.trim())}`)
        .then((r) => r.json() as Promise<{ results?: Array<{ preview: string; url: string; title: string }>; error?: string }>)
        .then((j) => {
          if (!live) return;
          setGifs(j.results ?? []);
          if (j.error) setProblem(j.error);
        })
        .catch(() => live && setProblem('Could not load GIFs.'));
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [mode, gifQ, gifsOn]);
  const sendGif = (url: string) => {
    send({ t: 'chat', text: `[image] ${url}` });
    setMode(null);
    setGifQ('');
  };

  const sendPicture = async (f: File) => {
    setProblem(null);
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return setProblem('Pick a PNG, JPEG, GIF or WebP picture.');
    if (f.size > 8 * 1024 * 1024) return setProblem('That picture is over 8 MB.');
    setBusy(true);
    try {
      const r = await fetch(`/api/chat-image?room=${encodeURIComponent(code)}`, { method: 'PUT', headers: { 'content-type': f.type }, body: f });
      const j = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!r.ok || !j.url) throw new Error(j.error ?? (r.status === 404 ? 'Sharing pictures needs the Node backend.' : `Upload failed (${r.status}).`));
      send({ t: 'chat', text: `[image] ${j.url}` });
      setMode(null);
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sendGifLink = () => {
    const link = gifLink.trim();
    if (!IMAGE_MSG.test(`[image] ${link}`)) return setProblem('Paste a direct GIF or picture link (it ends in .gif, .png, .jpg or .webp).');
    send({ t: 'chat', text: `[image] ${link}` });
    setGifLink('');
    setMode(null);
  };
  const pick = (m: 'image' | 'poll' | 'gif') => {
    setMenu(false);
    setProblem(null);
    if (m === 'image') fileRef.current?.click();
    else setMode(m);
  };
  const typing = useRoom((s) => s.typing);
  const me = useRoom((s) => s.me);
  const linkMode = useRoom((s) => s.sync.mode === 'link');
  const [text, setText] = useState('');
  const [, tick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastTypingSent = useRef(0);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.length]);

  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);

  const typers = Object.entries(typing)
    .filter(([id, v]) => v.until > Date.now() && id !== me?.id)
    .map(([, v]) => v.nick);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    send({ t: 'chat', text: t });
    setText('');
  };

  return (
    <div className="panel chat">
      <PollStrip creating={mode === 'poll'} onDone={() => setMode(null)} />
      <div className="chat-list" ref={listRef}>
        {chat.map((m) => (
          <div key={m.id} className={`msg ${m.system ? 'system' : ''}`}>
            {!m.system && <b className={m.fromId === me?.id ? 'me' : ''}>{m.nick}</b>}
            {!m.system && IMAGE_MSG.test(m.text) ? (
              <a className="chat-img" href={m.text.replace('[image] ', '')} target="_blank" rel="noreferrer noopener">
                <img src={m.text.replace('[image] ', '')} alt={`Picture from ${m.nick}`} loading="lazy" />
              </a>
            ) : (
            <span>
              {linkMode && !m.system
                ? m.text.split(TS).map((part, i) =>
                    i % 2 === 1 ? (
                      <button key={i} className="ts" onClick={() => requestSeek(toSeconds(part))}>
                        {part}
                      </button>
                    ) : (
                      <Fragment key={i}>{part}</Fragment>
                    ),
                  )
                : m.text}
            </span>
            )}
          </div>
        ))}
      </div>
      <div className="typing">{typers.length > 0 ? `${typers.slice(0, 2).join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…` : ' '}</div>
      {mode === 'gif' && gifsOn && (
        <div className="gif-picker">
          <input value={gifQ} onChange={(e) => setGifQ(e.target.value)} placeholder="Search GIFs" aria-label="Search GIFs" autoFocus />
          <div className="gif-grid">
            {gifs.map((g) => (
              <button key={g.url} type="button" title={g.title} onClick={() => sendGif(g.url)}>
                <img src={g.preview} alt={g.title} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}
      {mode === 'gif' && (
        <div className="chat-extra">
          <input value={gifLink} onChange={(e) => setGifLink(e.target.value)} placeholder="…or paste a GIF link (…/something.gif)" autoFocus={!gifsOn} />
          <button className="primary" type="button" disabled={!gifLink.trim()} onClick={sendGifLink}>
            Send
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} title="Choose a GIF file from this device">
            📁 File
          </button>
          <button type="button" className="icon-btn" aria-label="Close" onClick={() => setMode(null)}>
            ✕
          </button>
        </div>
      )}
      {(problem || busy) && <p className={`chat-note small ${problem ? 'warn' : 'muted'}`}>{problem ?? 'Sending picture…'}</p>}
      <input
        ref={fileRef}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/gif,image/webp"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void sendPicture(f);
        }}
      />
      <form onSubmit={submit} className="chat-form">
        <div className="chat-plus">
          <button type="button" className="icon-btn" aria-label="Share a picture, GIF or poll" aria-expanded={menu} disabled={me?.muted || busy} onClick={() => setMenu((v) => !v)}>
            +
          </button>
          {menu && (
            <div className="chat-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => pick('image')}>
                Picture
              </button>
              <button type="button" role="menuitem" onClick={() => pick('gif')}>
                GIF
              </button>
              {isOrganizer(me) && (
                <button type="button" role="menuitem" onClick={() => pick('poll')}>
                  Poll
                </button>
              )}
            </div>
          )}
        </div>
        <input
          value={text}
          maxLength={300}
          placeholder={me?.muted ? 'You are muted' : 'Say something…'}
          disabled={me?.muted}
          onChange={(e) => {
            setText(e.target.value);
            if (Date.now() - lastTypingSent.current > 2000) {
              lastTypingSent.current = Date.now();
              send({ t: 'typing' });
            }
          }}
        />
        <button className="primary" type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ people

export function PeoplePanel() {
  const members = useRoom((s) => s.members);
  const me = useRoom((s) => s.me);
  const isHost = me?.role === 'host';
  const ctl = isOrganizer(me);

  const report = (m: Member) => {
    const reason = window.prompt(`Report ${m.nick}. What is the problem?`, '');
    if (reason !== null) send({ t: 'report', id: m.id, reason });
  };

  return (
    <div className="panel">
      <ul className="people">
        {members.map((m) => (
          <li key={m.id}>
            <span className="name">
              {m.role === 'host' && '👑 '}
              {m.nick}
              {m.role === 'mod' && <span className="role-tag">Organizer</span>}
              {m.id === me?.id && <i className="muted"> (you)</i>}
              {m.voice && ' 🎙️'}
              {m.muted && ' 🔇'}
            </span>
            <span className="actions">
              {m.id !== me?.id && (
                <button className="link" onClick={() => report(m)}>
                  report
                </button>
              )}
              {isHost && m.role !== 'host' && (
                <button
                  className="link"
                  title={m.role === 'mod' ? 'They can no longer control playback' : 'They can play, pause, skip and load videos, run the queue, start polls and keep order, like you'}
                  onClick={() => send({ t: 'setRole', id: m.id, role: m.role === 'mod' ? 'viewer' : 'mod' })}
                >
                  {m.role === 'mod' ? 'remove organizer' : 'make organizer'}
                </button>
              )}
              {ctl && m.role === 'viewer' && (
                <button className="link" onClick={() => send({ t: 'mute', id: m.id, muted: !m.muted })}>
                  {m.muted ? 'unmute' : 'mute'}
                </button>
              )}
              {ctl && m.id !== me?.id && m.role !== 'host' && (isHost || m.role === 'viewer') && (
                <button className="link danger" onClick={() => window.confirm(`Remove ${m.nick}?`) && send({ t: 'kick', id: m.id })}>
                  kick
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------- queue

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export function QueuePanel() {
  const queue = useRoom((s) => s.queue);
  const history = useRoom((s) => s.history);
  const me = useRoom((s) => s.me);
  const sync = useRoom((s) => s.sync);
  const memberCount = useRoom((s) => s.members.length);
  const ctl = canControlPlayback(me?.role, memberCount);
  const organizer = isOrganizer(me);
  const yt = useYtdlp();
  const autoplay = useAutoplay((s) => s.on);
  const [view, setView] = useState<'playing' | 'suggestions'>('playing');
  const [input, setInput] = useState('');
  const [results, setResults] = useState<{ kind: 'search' | 'playlist'; title: string; entries: YtEntry[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const repeat = useRoom((s) => s.repeat);
  const pending = queue.filter((q) => !q.approved);
  const approved = queue.filter((q) => q.approved);
  const label = (q: { title?: string; kind: string | null; videoId: string | null; url: string }) =>
    q.title ?? (q.kind === 'youtube' ? `YouTube · ${q.videoId}` : q.kind === 'site' ? hostOf(q.url) : decodeURIComponent(q.url.split('?')[0]!.split('/').pop() ?? q.url));
  const nowId = youtubeIdOf(sync);
  const queued = new Set(queue.map((q) => q.videoId).filter((v): v is string => !!v));
  // oldest at the top, like a music app: what played, then what is playing, then what comes next
  const played = history;

  // host/mods add to "up next", everyone else suggests; nothing already queued or playing is added twice
  const add = (entries: YtEntry[]) => {
    const fresh = entries.filter((e) => !queued.has(e.id) && e.id !== nowId).slice(0, 200);
    if (fresh.length) send({ t: 'queueAddMany', items: fresh.map((e) => ({ url: watchUrl(e.id), title: e.title })) });
  };
  const play = (e: YtEntry) => send({ t: 'load', url: watchUrl(e.id), title: e.title });

  // the box takes a link (added as is), a playlist link (shows every song), or words (searches YouTube)
  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    setNote(null);
    const list = yt ? playlistIdOf(text) : null;
    if (looksLikeUrl(text) && !list) {
      const parsed = parseLink(text);
      if (parsed.ok && parsed.kind === 'site') {
        // not YouTube or a video file: ask yt-dlp first, so a link it cannot play never reaches the queue
        if (!yt) return useToast.getState().show('This server has no yt-dlp, so only YouTube links and direct video files work.');
        setBusy(true);
        try {
          const { title } = await checkLink(text);
          send({ t: 'queueAdd', url: text, ...(title ? { title } : {}) });
          setInput('');
        } catch (e) {
          useToast.getState().show(`yt-dlp: ${(e as Error).message}`);
        } finally {
          setBusy(false);
        }
        return;
      }
      send({ t: 'queueAdd', url: text });
      setInput('');
      return;
    }
    if (!yt) return setNote('Searching YouTube needs the Node backend with yt-dlp installed. Paste a link instead.');
    setBusy(true);
    setView('suggestions');
    try {
      const r = await fetchYt(list ? 'playlist' : 'search', list ?? text);
      setResults({ kind: list ? 'playlist' : 'search', title: list ? r.title || 'Playlist' : `Results for “${text}”`, entries: r.entries });
      if (!r.entries.length) setNote('Nothing found.');
      if (list) setInput('');
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (q: QueueItem, kind: 'played' | 'next') => (
    <li key={q.id} className={kind}>
      {q.videoId ? <img className="qthumb" src={thumbUrl(q.videoId)} alt="" loading="lazy" /> : <span className="qthumb qthumb-note">♪</span>}
      <span className="qtitle">
        <span className="qname" title={label(q)}>
          {label(q)}
        </span>
        {kind === 'next' && <span className="muted small">added by {q.by}</span>}
      </span>
      <span className="q-actions">
        {kind === 'played' &&
          (ctl ? (
            <button className="icon-btn" aria-label="Play again" onClick={() => send({ t: 'historyPlay', id: q.id })} title="Play this again for everyone">
              ↻
            </button>
          ) : (
            <button className="chipbtn" onClick={() => send({ t: 'queueAdd', url: q.url, title: q.title })} title="Suggest it again">
              + Suggest
            </button>
          ))}
        {kind === 'next' && (
          <>
            <button className={`vote ${q.votes.includes(me?.id ?? '') ? 'on' : ''}`} onClick={() => send({ t: 'queueVote', id: q.id })} title="Vote it up the list">
              ▲ {q.votes.length}
            </button>
            {ctl && (
              <button className="icon-btn" aria-label="Play now" title="Play now" onClick={() => send({ t: 'queuePlay', id: q.id })}>
                ▶
              </button>
            )}
            {(ctl || q.byId === me?.id) && (
              <button className="icon-btn danger" aria-label="Remove" title="Remove from Up next" onClick={() => send({ t: 'queueRemove', id: q.id })}>
                ✕
              </button>
            )}
          </>
        )}
      </span>
    </li>
  );

  return (
    <div className="panel queue-panel">
      <form
        className="row queue-search"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={yt ? 'Search YouTube, or paste a link / playlist' : ctl ? 'Add a YouTube / video link' : 'Suggest a YouTube / video link'}
          aria-label="Search YouTube or paste a link"
        />
        <button className="primary" type="submit" disabled={busy || !input.trim()}>
          {busy ? '…' : yt && input.trim() && !looksLikeUrl(input) ? '🔍 Search' : ctl ? 'Add' : 'Suggest'}
        </button>
      </form>
      {note && <p className="muted small">{note}</p>}

      <div className="subtabs" role="tablist">
        <button role="tab" aria-selected={view === 'playing'} className={view === 'playing' ? 'active' : ''} onClick={() => setView('playing')}>
          Playing now{approved.length ? ` · ${approved.length} next` : ''}
        </button>
        <button role="tab" aria-selected={view === 'suggestions'} className={view === 'suggestions' ? 'active' : ''} onClick={() => setView('suggestions')}>
          Suggestions{pending.length ? <span className="unread">{pending.length}</span> : null}
        </button>
      </div>

      {view === 'playing' && (
        <>
          <div className="row queue-tools">
            {ctl && (
              <button type="button" disabled={history.length === 0} onClick={() => send({ t: 'queuePrev' })} title="Play the previous video again (what is playing goes back to the top of Up next)">
                ⏮ Previous
              </button>
            )}
            {ctl && (
              <button type="button" disabled={approved.length === 0} onClick={() => send({ t: 'queueNext' })} title="Skip to the next video in Up next">
                ⏭ Next
              </button>
            )}
            {ctl && (
              <button type="button" disabled={approved.length < 2} onClick={() => send({ t: 'queueShuffle' })} title="Put the up-next list in a random order (clears votes)">
                🔀 Shuffle
              </button>
            )}
            <button
              type="button"
              disabled={!organizer}
              aria-label={`Repeat: ${repeat}`}
              title={organizer ? 'When a video ends and nothing is queued: stop, loop the whole list, or replay this video' : 'Only the host and organizers can change repeat'}
              onClick={() => send({ t: 'roomSettings', repeat: repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off' })}
            >
              {repeat === 'off' ? '🔁 Repeat: off' : repeat === 'all' ? '🔁 Repeat: all' : '🔂 Repeat: this video'}
            </button>
            {me?.role === 'host' && yt && (
              <label className="check small" title="When nothing is left in Up next, add a video like the one playing (YouTube's own suggestions)">
                <input type="checkbox" checked={autoplay} onChange={(e) => useAutoplay.getState().set(e.target.checked)} />
                Autoplay similar videos
              </label>
            )}
          </div>

          {history.length > 0 && (
            <>
              <h4>Played ({history.length})</h4>
              <ul className="queue played">{played.map((q) => row(q, 'played'))}</ul>
            </>
          )}

          {sync.mode === 'link' && sync.url && (
            <>
              <h4>Now playing</h4>
              <div className="now-playing">
                {nowId ? <img className="qthumb" src={thumbUrl(nowId)} alt="" /> : <span className="qthumb qthumb-note">♪</span>}
                <span className="qtitle">
                  <b>{label(sync)}</b>
                </span>
                <span className={`eq${sync.playing ? ' on' : ''}`} aria-label={sync.playing ? 'Playing' : 'Paused'}>
                  <i />
                  <i />
                  <i />
                </span>
              </div>
            </>
          )}

          <h4>
            Up next{approved.length ? ` (${approved.length})` : ''}
            {ctl && approved.length > 1 && (
              <button className="link danger" onClick={() => send({ t: 'queueClear' })} title="Remove everything from Up next">
                Clear
              </button>
            )}
          </h4>
          {approved.length === 0 && (
            <p className="muted small empty-next">
              Nothing queued.{' '}
              <button className="link" onClick={() => setView('suggestions')}>
                Find something to add →
              </button>
            </p>
          )}
          {approved.length > 0 && <ul className="queue">{approved.map((q) => row(q, 'next'))}</ul>}
          {!ctl && <p className="muted small">Anyone can suggest a video. The host or an organizer decides whether it plays.</p>}
        </>
      )}

      {view === 'suggestions' && (
        <>
          {results && (
            <section className="yt-results">
              <div className="row">
                <h4>
                  {results.title} ({results.entries.length})
                </h4>
                <span className="spacer" />
                {results.kind === 'playlist' && results.entries.length > 0 && (
                  <button className="chipbtn" onClick={() => add(results.entries)} title="Queue every song of this playlist, in order">
                    {ctl ? '+ Add all' : '+ Suggest all'}
                  </button>
                )}
                <button className="link" onClick={() => setResults(null)} aria-label="Close results">
                  ✕
                </button>
              </div>
              <YtRows entries={results.entries} queued={queued} nowId={nowId} ctl={ctl} onAdd={(e) => add([e])} onPlay={play} />
            </section>
          )}

          {pending.length > 0 && (
            <>
              <h4>From the room ({pending.length})</h4>
              <ul className="queue">
                {pending.map((q) => (
                  <li key={q.id}>
                    {q.videoId ? <img className="qthumb" src={thumbUrl(q.videoId)} alt="" loading="lazy" /> : <span className="qthumb qthumb-note">♪</span>}
                    <span className="qtitle">
                      <span className="qname" title={label(q)}>
                        {label(q)}
                      </span>
                      <span className="muted small">suggested by {q.by}</span>
                    </span>
                    <span className="q-actions">
                      <button className={`vote ${q.votes.includes(me?.id ?? '') ? 'on' : ''}`} onClick={() => send({ t: 'queueVote', id: q.id })} title="Vote for this suggestion">
                        ▲ {q.votes.length}
                      </button>
                      {ctl ? (
                        <>
                          <button className="icon-btn" aria-label="Play now" title="Play now" onClick={() => send({ t: 'queuePlay', id: q.id })}>
                            ▶
                          </button>
                          <button className="icon-btn" aria-label="Approve" title="Approve: add to Up next" onClick={() => send({ t: 'queueApprove', id: q.id })}>
                            ✓
                          </button>
                          <button className="icon-btn danger" aria-label="Remove" title="Reject" onClick={() => send({ t: 'queueRemove', id: q.id })}>
                            ✕
                          </button>
                        </>
                      ) : (
                        q.byId === me?.id && (
                          <button className="icon-btn danger" aria-label="Remove" title="Take back your suggestion" onClick={() => send({ t: 'queueRemove', id: q.id })}>
                            ✕
                          </button>
                        )
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {yt && nowId && <SuggestedNext videoId={nowId} queued={queued} ctl={ctl} onAdd={(e) => add([e])} onPlay={play} />}
          {!results && pending.length === 0 && !(yt && nowId) && <p className="muted small">Search above to find something, or paste a link or a playlist.</p>}
        </>
      )}
    </div>
  );
}

interface RowsProps {
  entries: YtEntry[];
  queued: Set<string>;
  nowId?: string | null;
  ctl: boolean;
  onAdd(e: YtEntry): void;
  onPlay(e: YtEntry): void;
}

/** Search results, playlist songs and suggestions: thumbnail, title, channel and length, then add/play. */
function YtRows({ entries, queued, nowId, ctl, onAdd, onPlay }: RowsProps) {
  return (
    <ul className="yt-list">
      {entries.map((e) => (
        <li key={e.id} className={e.id === nowId ? 'now' : ''}>
          <img className="qthumb" src={thumbUrl(e.id)} alt="" loading="lazy" />
          <span className="yt-meta">
            <b title={e.title}>{e.title}</b>
            <span className="muted small">{[e.channel, formatDuration(e.duration)].filter(Boolean).join(' · ')}</span>
          </span>
          {e.id === nowId ? (
            <span className="muted small">▶ playing</span>
          ) : queued.has(e.id) ? (
            <span className="muted small">✓ queued</span>
          ) : (
            <span className="yt-actions">
              {ctl && (
                <button className="icon-btn" onClick={() => onPlay(e)} title="Play this for everyone now" aria-label={`Play ${e.title} now`}>
                  ▶
                </button>
              )}
              <button className="chipbtn" onClick={() => onAdd(e)} title={ctl ? 'Add to Up next' : 'Suggest it to the host'}>
                {ctl ? '+ Add' : '+ Suggest'}
              </button>
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** "Suggested next": YouTube's own list of videos like the one playing. */
function SuggestedNext({ videoId, ...rows }: Omit<RowsProps, 'entries' | 'nowId'> & { videoId: string }) {
  const [list, setList] = useState<YtEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    setList(null);
    setError(null);
    fetchYt('related', videoId)
      .then((r) => live && setList(r.entries))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [videoId]);

  return (
    <section className="yt-suggested">
      <h4>Suggested next</h4>
      {error && <p className="muted small">Could not load suggestions: {error}</p>}
      {!list && !error && <p className="muted small">Finding videos like this one…</p>}
      {list && <YtRows entries={all ? list : list.slice(0, 8)} {...rows} />}
      {list && list.length > 8 && (
        <button className="link" onClick={() => setAll((a) => !a)}>
          {all ? 'Show fewer' : `Show all ${list.length}`}
        </button>
      )}
    </section>
  );
}

// ------------------------------------------------------------------- polls

/** The poll, at the top of the chat: results while one runs, and (host/mods) a small form to start one. */
function PollStrip({ creating, onDone }: { creating: boolean; onDone(): void }) {
  const poll = useRoom((s) => s.poll);
  const me = useRoom((s) => s.me);
  const ctl = isOrganizer(me);
  const [q, setQ] = useState('');
  const [opts, setOpts] = useState('Yes\nNo');

  const counts = useMemo(() => {
    const c = poll ? poll.options.map(() => 0) : [];
    if (poll) for (const idx of Object.values(poll.votes)) if (c[idx] !== undefined) c[idx]! += 1;
    return c;
  }, [poll]);
  const total = counts.reduce((a, b) => a + b, 0);
  const mine = poll && me ? poll.votes[me.id] : undefined;
  if (!poll && !creating) return null;

  return (
    <div className="chat-poll">
      {poll && (
        <div className="poll">
          <div className="row">
            <b>📊 {poll.question}</b>
            <span className="spacer" />
            {ctl && poll.open && (
              <button className="link" onClick={() => send({ t: 'pollClose' })}>
                Close poll
              </button>
            )}
          </div>
          {poll.options.map((o, i) => (
            <button key={i} className={`opt ${mine === i ? 'on' : ''}`} disabled={!poll.open} onClick={() => send({ t: 'pollVote', index: i })}>
              <span className="bar" style={{ width: `${total ? (counts[i]! / total) * 100 : 0}%` }} />
              <span className="label">{o}</span>
              <span className="count">{counts[i]}</span>
            </button>
          ))}
          <p className="muted small">
            {total} vote{total === 1 ? '' : 's'} · {poll.open ? 'open' : 'closed'}
          </p>
        </div>
      )}
      {ctl && creating && (
        <form
          className="poll-form"
          onSubmit={(e) => {
            e.preventDefault();
            const options = opts
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
              .slice(0, 4);
            if (q.trim() && options.length >= 2) {
              send({ t: 'pollCreate', question: q.trim(), options });
              setQ('');
              onDone();
            }
          }}
        >
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Question (e.g. Skip this video?)" maxLength={120} autoFocus />
          <textarea value={opts} onChange={(e) => setOpts(e.target.value)} rows={3} placeholder="One option per line (2–4)" />
          <div className="row">
            <button className="primary" type="submit">
              Start poll
            </button>
            <button type="button" onClick={onDone}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- room

export function RoomPanel() {
  const code = useRoom((s) => s.code);
  const locked = useRoom((s) => s.locked);
  const hasPassword = useRoom((s) => s.hasPassword);
  const chat = useRoom((s) => s.chat);
  const me = useRoom((s) => s.me);
  const isHost = me?.role === 'host';
  const [qr, setQr] = useState('');
  const [theme, setThemeState] = useState<Theme>(getTheme());
  const [accent, setAccent] = useState(getAccent());
  const chooseTheme = (t: Theme, a: string) => {
    setThemeState(t);
    setAccent(a);
    saveTheme(t, a);
  };
  const [pw, setPw] = useState('');
  const [copied, setCopied] = useState(false);
  const link = `${location.origin}/r/${code}`;

  useEffect(() => {
    void QRCode.toDataURL(link, { margin: 1, width: 180, color: { dark: '#0e0f13', light: '#ffffff' } }).then(setQr);
  }, [link]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  };

  const exportChat = () => {
    const lines = chat.map((m) => `[${new Date(m.at).toLocaleTimeString()}] ${m.system ? '* ' : `${m.nick}: `}${m.text}`);
    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `chat-${code}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="panel">
      <h4>Invite</h4>
      <div className="row">
        <input readOnly value={link} onFocus={(e) => e.target.select()} />
        <button className="primary" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {qr && <img className="qr" src={qr} alt={`QR code for room ${code}`} width={180} height={180} />}

      {isHost && (
        <>
          <h4>Room settings</h4>
          <label className="check">
            <input type="checkbox" checked={locked} onChange={(e) => send({ t: 'roomSettings', locked: e.target.checked })} />
            Lock room (no new people can join)
          </label>
          <div className="row">
            <input value={pw} onChange={(e) => setPw(e.target.value)} placeholder={hasPassword ? 'Password set' : 'Room password (optional)'} maxLength={64} />
            <button onClick={() => send({ t: 'roomSettings', password: pw || null })}>{pw ? 'Set' : 'Clear'}</button>
          </div>
        </>
      )}

      <h4>Appearance</h4>
      <div className="row">
        <button type="button" className={theme === 'dark' ? 'primary' : ''} aria-pressed={theme === 'dark'} onClick={() => chooseTheme('dark', accent)}>
          🌙 Dark
        </button>
        <button type="button" className={theme === 'light' ? 'primary' : ''} aria-pressed={theme === 'light'} onClick={() => chooseTheme('light', accent)}>
          ☀️ Light
        </button>
      </div>
      <div className="swatches" role="group" aria-label="Accent colour">
        {ACCENTS.map((c) => (
          <button key={c} type="button" className={`swatch ${accent.toLowerCase() === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Accent colour ${c}`} aria-pressed={accent.toLowerCase() === c} onClick={() => chooseTheme(theme, c)} />
        ))}
        <input type="color" value={accent} aria-label="Custom accent colour" onChange={(e) => chooseTheme(theme, e.target.value)} />
      </div>

      <h4>Keyboard shortcuts</h4>
      <ul className="shortcuts small">
        <li><kbd>Space</kbd> / <kbd>K</kbd> play or pause</li>
        <li><kbd>←</kbd> / <kbd>J</kbd> back 5 s · <kbd>→</kbd> / <kbd>L</kbd> forward 5 s</li>
        <li><kbd>↑</kbd> <kbd>↓</kbd> volume · <kbd>M</kbd> mute</li>
        <li><kbd>F</kbd> fullscreen · <kbd>C</kbd> subtitles</li>
      </ul>
      <p className="muted small">Viewers can never go forward past the host, even with the keyboard.</p>

      <h4>Before you go</h4>
      <button onClick={exportChat}>Download chat log</button>
      <p className="muted small">Chat lives only in memory and disappears when the room closes. Download it now if you want a copy.</p>
    </div>
  );
}

export { REACTIONS, formatTime };
