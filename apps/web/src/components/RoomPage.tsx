import { useEffect, useRef, useState } from 'react';
import { getNick, joinRoom, leaveRoom, retryWithPassword, send, setNick, useRoom } from '../lib/room';
import { LinkPlayer } from './LinkPlayer';
import { StreamHost } from './StreamHost';
import { HostedUpload } from './HostedUpload';
import { StreamViewer } from './StreamViewer';
import { ChatPanel, PeoplePanel, QueuePanel, RoomPanel } from './Panels';
import { ReactionBar, ReactionLayer } from './Reactions';
import { VoiceBar } from './VoiceBar';
import { CallGrid } from './CallGrid';
import { checkLink, useAutoplaySuggestions, useServerOutdated, useYtdlp } from '../lib/ytlists';
import { canControlPlayback, isTorrentLink, parseLink } from '@wp/shared';
import { useToast } from '../lib/toast';
import type { ChatMsg } from '@wp/shared';

type Tab = 'chat' | 'people' | 'queue';

export function RoomPage({ code, navigate }: { code: string; navigate: (p: string) => void }) {
  const status = useRoom((s) => s.status);
  const error = useRoom((s) => s.error);
  const errorCode = useRoom((s) => s.errorCode);
  const sync = useRoom((s) => s.sync);
  const stream = useRoom((s) => s.stream);
  const me = useRoom((s) => s.me);
  const members = useRoom((s) => s.members);
  const queueLen = useRoom((s) => s.queue.length);
  const poll = useRoom((s) => s.poll);

  const [nick, setNickState] = useState(getNick());
  const [wantsCreate] = useState(() => sessionStorage.getItem(`wp-create-${code}`) === '1');
  // auto-join when creating, refreshing a tab we were already in, or returning as the host
  const [started, setStarted] = useState(
    () =>
      !!getNick() &&
      (wantsCreate || sessionStorage.getItem(`wp-joined-${code}`) === '1' || !!localStorage.getItem(`wp-host-${code}`)),
  );
  const [pw, setPw] = useState('');
  const [tab, setTab] = useState<Tab>('chat');
  const [showStream, setShowStream] = useState(false);
  const [pickTick, setPickTick] = useState(0);
  const [screenTick, setScreenTick] = useState(0);
  // getDisplayMedia is missing on phone browsers and on plain-http pages (not a secure context)
  const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const screenShareReason = canScreenShare
    ? null
    : window.isSecureContext
      ? 'Not available here: this browser does not support screen sharing (phones and tablets do not).'
      : 'Not available here: screen sharing only works on a secure page. Open this site with https:// (run `pnpm dev:https`), or use http://localhost on the same computer.';
  const [link, setLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  // like YouTube autoplay: when Up next runs empty, the host's page queues a video like the one playing
  useAutoplaySuggestions(me?.role === 'host');
  const serverOutdated = useServerOutdated();
  const ytOnServer = useYtdlp();
  const [checking, setChecking] = useState(false);
  // "Play for everyone": a link that is not YouTube or a video file is checked by yt-dlp first; its reason
  // shows in a pop-up when it cannot be played
  const playForEveryone = async (raw: string) => {
    const p = parseLink(raw);
    // a torrent needs no yt-dlp check: the host's page downloads it on the server (see HostedUpload)
    if (!p.ok || p.kind !== 'site' || isTorrentLink(raw)) return send({ t: 'load', url: raw });
    if (!ytOnServer) return useToast.getState().show('This server has no yt-dlp, so only YouTube links and direct video files work.');
    setChecking(true);
    try {
      const { title } = await checkLink(raw);
      send({ t: 'load', url: raw, ...(title ? { title } : {}) });
    } catch (e) {
      useToast.getState().show(`yt-dlp: ${(e as Error).message}`);
    } finally {
      setChecking(false);
    }
  };
  const notice = useToast((s) => s.toast);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => useToast.getState().hide(), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  // ---- new chat while you are not looking at it: a count on the Chat tab, a short pop-up, and the tab title
  const chat = useRoom((s) => s.chat);
  const sideRef = useRef<HTMLElement>(null);
  const [unread, setUnread] = useState(0);
  const [toast, setToast] = useState<ChatMsg | null>(null);
  const lastSeenId = useRef<string | null>(null);
  const sideOnScreen = useRef(true);
  const chatVisible = () => tab === 'chat' && sideOnScreen.current && !document.hidden;
  useEffect(() => {
    const el = sideRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // on a phone the chat sits below the player, so being on the Chat tab does not mean seeing it
    const io = new IntersectionObserver(([e]) => {
      sideOnScreen.current = !!e && e.intersectionRatio > 0.25;
      if (chatVisible()) setUnread(0);
    }, { threshold: [0, 0.25, 0.5] });
    io.observe(el);
    return () => io.disconnect();
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const i = lastSeenId.current ? chat.findIndex((m) => m.id === lastSeenId.current) : chat.length - 1;
    if (i === -1 && lastSeenId.current) {
      lastSeenId.current = chat[chat.length - 1]?.id ?? null;
      return;
    }
    const fresh = chat.slice(i + 1).filter((m) => !m.system && m.fromId !== me?.id);
    lastSeenId.current = chat[chat.length - 1]?.id ?? null;
    if (!fresh.length || chatVisible()) return;
    setUnread((n) => n + fresh.length);
    setToast(fresh[fresh.length - 1]!);
  }, [chat]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (tab === 'chat' && sideOnScreen.current) setUnread(0);
  }, [tab]);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const back = () => !document.hidden && chatVisible() && setUnread(0);
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.title = unread ? `(${unread}) Couchline` : 'Couchline';
  }, [unread]);
  const openChat = () => {
    setTab('chat');
    setToast(null);
    setUnread(0);
    sideRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  useEffect(() => {
    if (!started) return;
    joinRoom({ code, nick, create: wantsCreate });
    sessionStorage.removeItem(`wp-create-${code}`);
  }, [started, code]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status === 'joined') sessionStorage.setItem(`wp-joined-${code}`, '1');
  }, [status, code]);

  useEffect(() => () => leaveRoom(), []);

  useEffect(() => {
    // a stream or a hosted video is now on the stage: leave the stream panel (it is for starting a stream)
    if (sync.mode === 'stream' || sync.mode === 'link') setShowStream(false);
  }, [sync.mode]);

  // Fullscreen: hide the controls and the mouse cursor after 3 s without movement, bring them back on any activity.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let timer: number | undefined;
    const wake = () => {
      el.classList.remove('idle');
      window.clearTimeout(timer);
      if (document.fullscreenElement === el) timer = window.setTimeout(() => el.classList.add('idle'), 3000);
    };
    el.addEventListener('mousemove', wake);
    el.addEventListener('pointerdown', wake);
    document.addEventListener('keydown', wake);
    document.addEventListener('fullscreenchange', wake);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove('idle');
      el.removeEventListener('mousemove', wake);
      el.removeEventListener('pointerdown', wake);
      document.removeEventListener('keydown', wake);
      document.removeEventListener('fullscreenchange', wake);
    };
  }, [status]);

  const leave = () => {
    sessionStorage.removeItem(`wp-joined-${code}`);
    leaveRoom();
    navigate('/');
  };

  const fullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/r/${code}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy this invite link:', `${location.origin}/r/${code}`);
    }
  };

  // ------------------------------------------------------------ gate screens
  if (!started) {
    return (
      <div className="center-card">
        <h1>Join room {code}</h1>
        <p className="muted">Pick a nickname. No account needed.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!nick.trim()) return;
            setNick(nick.trim());
            setStarted(true);
          }}
        >
          <input autoFocus value={nick} onChange={(e) => setNickState(e.target.value)} placeholder="Your nickname" maxLength={24} />
          <button className="primary" type="submit" disabled={!nick.trim()}>
            Join
          </button>
        </form>
      </div>
    );
  }

  if (status === 'kicked' || (status === 'error' && errorCode !== 'bad_password')) {
    const title = status === 'kicked' ? 'Removed from room' : errorCode === 'not_found' ? 'Room not found' : 'Cannot join';
    return (
      <div className="center-card">
        <h1>{title}</h1>
        <p className="muted">{error}</p>
        <button className="primary" onClick={leave}>
          Back to home
        </button>
      </div>
    );
  }

  if (status === 'error' && errorCode === 'bad_password') {
    return (
      <div className="center-card">
        <h1>Room password</h1>
        <p className="muted">{error}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            retryWithPassword(pw);
          }}
        >
          <input autoFocus type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" />
          <button className="primary" type="submit">
            Enter
          </button>
        </form>
      </div>
    );
  }

  if (status === 'idle' || status === 'connecting' || !me) {
    return (
      <div className="center-card">
        <p className="muted">Connecting…</p>
      </div>
    );
  }

  // --------------------------------------------------------------- the room
  const isHost = me.role === 'host';
  const ctl = canControlPlayback(me.role, members.length);

  let stage: React.ReactNode;
  if (sync.mode === 'stream') {
    stage = isHost ? <StreamHost key="host-stream" pickSignal={pickTick} screenSignal={screenTick} /> : <StreamViewer key="viewer-stream" onFullscreen={fullscreen} />;
  } else if (isHost && (sync.mode === 'idle' || showStream)) {
    stage = <StreamHost key="host-stream" pickSignal={pickTick} screenSignal={screenTick} />;
  } else if (sync.mode === 'link') {
    stage = <LinkPlayer onFullscreen={fullscreen} />;
  } else {
    stage = (
      <div className="idle">
        <h2>Nothing playing yet</h2>
        <p className="muted">{ctl ? 'Paste a YouTube or video link below to start.' : 'Waiting for the host to start something…'}</p>
      </div>
    );
  }

  const hostAway = sync.mode === 'stream' && !stream.live;
  // the host's "Stream from your computer" card is on the stage (it has its own file and screen buttons)
  const startCard = isHost && sync.mode !== 'stream' && (sync.mode === 'idle' || showStream);

  return (
    <div className="room">
      <header className="topbar">
        <b className="logo">
          ▶ <span className="logo-text">Couchline</span>
        </b>
        <button className="chip" onClick={copyInvite} title="Copy invite link">
          {code} <span>{copied ? '✓ copied' : '⧉'}</span>
        </button>
        <button className="icon-btn" aria-label="Room settings" title="Invite, QR code, lock and password, theme" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        {settingsOpen && <RoomDialog onClose={() => setSettingsOpen(false)} />}
        <span className="muted">{members.length} here</span>
        {hostAway && <span className="pill warn">Host away</span>}
        <span className="spacer" />
        <button onClick={leave}>Leave</button>
      </header>

      {status === 'reconnecting' && <div className="banner">Connection lost. Reconnecting…</div>}
      {notice && (
        <div className="app-toast" role="alert" key={notice.id}>
          <span>⚠️ {notice.text}</span>
          <button className="icon-btn" aria-label="Dismiss" onClick={() => useToast.getState().hide()}>
            ✕
          </button>
        </div>
      )}
      {toast && (
        <button className="chat-toast" onClick={openChat} aria-live="polite">
          <b>{toast.nick}</b> {toast.text}
        </button>
      )}
      {serverOutdated && (
        <div className="banner">
          The server is older than this page, so the queue, playlists and suggestions will misbehave. Stop it (Ctrl+C) and run pnpm dev again.
        </div>
      )}

      <div className="main">
        <section className="left">
          <div className="stage" ref={wrapRef}>
            {stage}
            <ReactionLayer />
          </div>

          <CallGrid />

          <div className="below">
            <ReactionBar />
            <VoiceBar />
          </div>

          {ctl && (
            <section className="source-card" aria-label="Choose what to watch">
              <form
                className="source-row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (link.trim()) void playForEveryone(link.trim());
                  setLink('');
                }}
              >
                <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Paste a YouTube or video link…" aria-label="Video link" />
                <button className="primary" type="submit" disabled={!link.trim() || checking}>
                  {checking ? 'Checking…' : '▶ Play for everyone'}
                </button>
              </form>
              {isHost && sync.mode !== 'stream' && (
                <div className="source-chips">
                  {/* the start card on the stage already offers these two, so only show them once a video is up */}
                  {!startCard && (
                    <button
                      type="button"
                      className="chipbtn"
                      title="Pick a video file on this device and stream it to everyone in the room"
                      onClick={() => {
                        setShowStream(true);
                        setPickTick((n) => n + 1);
                      }}
                    >
                      📁 Stream a file
                    </button>
                  )}
                  {/* ...except screen sharing where it cannot work: the start card hides its button, so this one says why */}
                  {(!startCard || !canScreenShare) && (
                    <button
                      type="button"
                      className="chipbtn"
                      disabled={!canScreenShare}
                      title={screenShareReason ?? 'Share a screen, window or browser tab (with sound) with everyone in the room'}
                      onClick={() => {
                        setShowStream(true);
                        setScreenTick((n) => n + 1);
                      }}
                    >
                      🖥️ Share screen / tab
                    </button>
                  )}
                  <HostedUpload link={link} onLinkUsed={() => setLink('')} />
                  {sync.mode === 'link' && showStream && (
                    <button type="button" className="chipbtn" onClick={() => setShowStream(false)}>
                      ← Back to the video
                    </button>
                  )}
                  {screenShareReason && <span className="muted small source-note">{screenShareReason}</span>}
                </div>
              )}
            </section>
          )}
        </section>

        <aside className="side" ref={sideRef}>
          <nav className="tabs" role="tablist">
            {(
              [
                ['chat', poll?.open ? 'Chat 📊' : 'Chat'],
                ['people', `People ${members.length}`],
                ['queue', `Queue${queueLen ? ` ${queueLen}` : ''}`],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => {
                  setTab(id);
                  if (id === 'chat') setUnread(0);
                }}>
                {label}
                {id === 'chat' && unread > 0 && (
                  <span className="unread" aria-label={`${unread} unread`}>
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </button>
            ))}
          </nav>
          {tab === 'chat' && <ChatPanel />}
          {tab === 'people' && <PeoplePanel />}
          {tab === 'queue' && <QueuePanel />}
        </aside>
      </div>
    </div>
  );
}

/** Room settings in a small dialog off the top bar: invite link and QR, lock and password, theme. */
function RoomDialog({ onClose }: { onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    d?.showModal();
    return () => d?.close();
  }, []);
  return (
    <dialog ref={ref} className="room-dialog" aria-label="Room settings" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="row room-dialog-head">
        <h3>Room</h3>
        <span className="spacer" />
        <button className="icon-btn" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <RoomPanel />
    </dialog>
  );
}
