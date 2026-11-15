/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from 'react';
import { canControlPlayback, clampSeek, computePosition, parseSubtitles, type Cue } from '@wp/shared';
import { onSeekRequest, send, serverNow, useRoom } from '../lib/room';
import { htmlApi, loadYT, sharedVideo, ytApi, type PlayerApi } from '../lib/yt';
import { Controls, SubtitleOverlay, TapControls, useWake } from './Controls';
import { SettingsMenu } from './SettingsMenu';
import { useMediaSession, usePlayerShortcuts } from '../lib/shortcuts';
import { youtubeIdOf } from '../lib/ytlists';

interface Props {
  onFullscreen(): void;
}

/** Remount the inner player whenever the video changes. */
export function LinkPlayer(props: Props) {
  const url = useRoom((s) => s.sync.url);
  return <LinkInner key={url} {...props} />;
}

function LinkInner({ onFullscreen }: Props) {
  const sync = useRoom((s) => s.sync);
  const me = useRoom((s) => s.me);
  const memberCount = useRoom((s) => s.members.length);
  const canControl = canControlPlayback(me?.role, memberCount);
  const hasPrevious = useRoom((s) => s.history.length > 0);

  const holderRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  // the browser would not start with sound, so we play muted until someone taps
  const [soundBlocked, setSoundBlocked] = useState(false);
  const lastToggle = useRef(0);
  const [tapShown, wakeTap] = useWake();
  const apiRef = useRef<PlayerApi | null>(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;
  const canRef = useRef(canControl);
  canRef.current = canControl;

  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attached, setAttached] = useState(true);
  const attachedRef = useRef(true);
  const setAtt = (v: boolean) => {
    attachedRef.current = v;
    setAttached(v);
  };
  const [cur, setCur] = useState(0);
  const [dur, setDur] = useState(0);
  const [live, setLive] = useState(0);
  const [playingLocal, setPlayingLocal] = useState(false);
  const [needTap, setNeedTap] = useState(false);
  const [volume, setVolume] = useState(() => Number(localStorage.getItem('wp-volume') ?? 80));
  const [cues, setCues] = useState<Cue[] | null>(null);
  // hosted (HLS) videos: qualities, audio tracks, subtitle files, title. Empty for YouTube and plain files.
  const hlsRef = useRef<any>(null);
  const [levels, setLevels] = useState<Array<{ label: string; index: number }>>([]);
  const [level, setLevel] = useState(-1);
  const [autoHeight, setAutoHeight] = useState(0);
  const [audioNames, setAudioNames] = useState<string[]>([]);
  const [namedAudio, setNamedAudio] = useState<string[]>([]);
  const [audioIdx, setAudioIdx] = useState(0);
  const [subTracks, setSubTracks] = useState<Array<{ name: string; url: string }>>([]);
  const [subIdx, setSubIdx] = useState(-1);
  const [title, setTitle] = useState('Couchline');
  const [speed, setSpeed] = useState(1);
  // a file with sound only (music mode, an uploaded song): show its cover instead of a black box
  const [audioOnly, setAudioOnly] = useState(false);
  // A hosted copy plays while it is still converting, so the player only knows the length converted so far and
  // the total kept growing. The server knows the real length: ask once and show that instead.
  const [fullDur, setFullDur] = useState(0);
  // switching from a YouTube video to its copy: show that video's picture until the copy's first frame plays
  const copyOfYoutube = sync.kind === 'hls' ? youtubeIdOf(sync) : null;
  const [switching, setSwitching] = useState(!!copyOfYoutube);
  useEffect(() => {
    const m = /\/media\/([0-9a-f-]{36})\//.exec(sync.url);
    if (!m) return;
    let live = true;
    fetch(`/api/media/${m[1]}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ duration?: number }>) : null))
      .then((j) => live && j && typeof j.duration === 'number' && j.duration > 0 && setFullDur(j.duration))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sync.url]);
  // like YouTube Music's Song / Video: each person picks, the room stays in sync either way
  const [watchMode, setWatchMode] = useState<'video' | 'audio'>(() => (localStorage.getItem('wp-watch') === 'audio' ? 'audio' : 'video'));
  const pickWatch = (m: 'video' | 'audio') => {
    setWatchMode(m);
    localStorage.setItem('wp-watch', m);
  };
  const upNextTitle = useRoom((s) => s.queue.find((x) => x.approved)?.title ?? null);
  const suppressUntil = useRef(0);
  const wantSince = useRef(0);
  const endedSent = useRef(false);

  const onEnded = useCallback(() => {
    if (canRef.current && !endedSent.current) {
      endedSent.current = true;
      send({ t: 'ended', position: apiRef.current?.duration() ?? 0 });
    }
  }, []);

  // create the underlying player once
  useEffect(() => {
    let dead = false;
    let yt: any = null;
    let hls: any = null;
    let detach: (() => void) | null = null;
    const holder = holderRef.current;
    if (sync.kind === 'youtube' && sync.videoId && holder) {
      loadYT()
        .then((YT) => {
          if (dead) return;
          const el = document.createElement('div');
          holder.appendChild(el);
          yt = new YT.Player(el, {
            videoId: sync.videoId,
            width: '100%',
            height: '100%',
            playerVars: { controls: 0, disablekb: 1, rel: 0, modestbranding: 1, playsinline: 1, fs: 0, iv_load_policy: 3, origin: location.origin },
            events: {
              onReady: () => {
                if (dead) return;
                apiRef.current = ytApi(yt);
                setReady(true);
              },
              onStateChange: (e: any) => {
                if (e.data === 0) onEnded();
              },
              onError: () => setLoadError('This video cannot be played here (embedding disabled or unavailable).'),
            },
          });
        })
        .catch((e: Error) => setLoadError(e.message));
    } else if ((sync.kind === 'file' || sync.kind === 'hls') && slotRef.current) {
      // the same element for every track (see sharedVideo): whatever unlocked its sound once keeps it unlocked
      const v = sharedVideo();
      slotRef.current.appendChild(v);
      videoRef.current = v;
      v.muted = false;
      v.playbackRate = 1;
      v.defaultPlaybackRate = 1;
      if (sync.kind === 'file') v.src = sync.url;
      // the shared element keeps whatever poster it had: give it this video's picture, or none
      const ytPic = youtubeIdOf(syncRef.current);
      v.poster = ytPic ? `https://i.ytimg.com/vi/${ytPic}/hqdefault.jpg` : '';
      apiRef.current = htmlApi(v);
      // a seek that lands well behind the host (media keys, PiP, ...) means this viewer is rewinding
      const onSeeking = () => {
        if (canRef.current) return;
        const liveT = computePosition(syncRef.current, serverNow());
        if (v.currentTime < liveT - 1.5) {
          attachedRef.current = false;
          setAttached(false);
        }
      };
      const onError = () => setLoadError('Could not load that video file.');
      const checkPicture = () => setAudioOnly(v.readyState >= 1 && v.videoWidth === 0);
      const onMuted = () => setSoundBlocked(true);
      // Phones pause media when the screen locks or another app opens. Keep the room's music going there,
      // unless it was someone pressing pause (here or on the lock screen) just now.
      const onPause = () => {
        if (!document.hidden || Date.now() - lastToggle.current < 1500) return;
        if (syncRef.current.playing && (attachedRef.current || canRef.current)) void v.play().catch(() => undefined);
      };
      const listeners: Array<[string, () => void]> = [
        ['ended', onEnded],
        ['seeking', onSeeking],
        ['error', onError],
        ['loadedmetadata', checkPicture],
        ['resize', checkPicture],
        ['wp-muted-autoplay', onMuted],
        ['pause', onPause],
        ['playing', () => setSwitching(false)],
      ];
      for (const [ev, fn] of listeners) v.addEventListener(ev, fn);
      detach = () => {
        for (const [ev, fn] of listeners) v.removeEventListener(ev, fn);
        videoRef.current = null;
      };
      if (sync.kind === 'hls') {
        // a chunked (YouTube-style) stream, e.g. a video the server converted: hls.js, or native HLS on Safari
        import('hls.js')
          .then(({ default: Hls }) => {
            if (dead) return;
            if (Hls.isSupported()) {
              // start loading where the room is right now: a copy taking over mid-video does not load 0:00 first
              hls = new Hls({ maxBufferLength: 30, startPosition: Math.max(0, computePosition(syncRef.current, serverNow())) });
              hls.on(Hls.Events.ERROR, (_e: unknown, data: { fatal?: boolean; type?: string; details?: string }) => {
                console.warn('[hls]', data.type, data.details, data.fatal ? '(fatal)' : '');
                if (!data.fatal) return;
                if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
                else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                else setLoadError('Could not play this stream.');
              });
              hlsRef.current = hls;
              hls.on(Hls.Events.MANIFEST_PARSED, () => {
                const list = (hls.levels as Array<{ height: number }>).map((l, index) => ({ index, label: l.height ? `${l.height}p` : `Level ${index + 1}` }));
                setLevels(list.reverse()); // highest quality first
              });
              hls.on(Hls.Events.LEVEL_SWITCHED, (_e: unknown, d: { level: number }) => setAutoHeight(hls.levels[d.level]?.height ?? 0));
              hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => setAudioNames((hls.audioTracks as Array<{ name: string }>).map((t) => t.name)));
              hls.on(Hls.Events.AUDIO_TRACK_SWITCHED, (_e: unknown, d: { id: number }) => setAudioIdx(d.id));
              hls.loadSource(sync.url);
              hls.attachMedia(v);
              // the server describes the tracks in tracks.json next to the playlist: friendly names, subtitle files, title
              const base = sync.url.slice(0, sync.url.lastIndexOf('/') + 1);
              fetch(`${base}tracks.json`)
                .then((r) => (r.ok ? r.json() : null))
                .then((j: { title?: string; audio?: Array<{ name: string }>; subtitles?: Array<{ url: string; name: string }> } | null) => {
                  if (!j || dead) return;
                  if (j.title) setTitle(j.title);
                  setNamedAudio((j.audio ?? []).map((a) => a.name));
                  setSubTracks((j.subtitles ?? []).map((s) => ({ name: s.name, url: `${base}${s.url}` })));
                })
                .catch(() => undefined);
            } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
              v.src = sync.url;
            } else {
              setLoadError('This browser cannot play streamed video.');
            }
          })
          .catch(() => setLoadError('Could not load the video player.'));
      }
      setReady(true);
    }
    return () => {
      dead = true;
      hls?.destroy();
      hlsRef.current = null;
      apiRef.current?.destroy();
      apiRef.current = null;
      detach?.();
      if (holder) holder.innerHTML = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    apiRef.current?.setVolume(volume);
    localStorage.setItem('wp-volume', String(volume));
  }, [volume, ready]);

  // the sync loop
  useEffect(() => {
    if (!ready) return;
    const id = window.setInterval(() => {
      const api = apiRef.current;
      if (!api) return;
      const s = syncRef.current;
      const d = api.duration();
      let liveT = computePosition(s, serverNow());
      if (d > 0 && liveT > d) liveT = d;
      const t = api.time();
      const playing = api.playing();
      setCur(t);
      setLive(liveT);
      setDur(d);
      setPlayingLocal(playing);

      const suppressed = Date.now() < suppressUntil.current;
      const finished = api.ended();
      // a new play-through re-arms the "ended" report (needed for queue auto-advance)
      if (s.playing && !finished) endedSent.current = false;
      if (attachedRef.current || canRef.current) {
        if (!suppressed) {
          if (Math.abs(t - liveT) > 1.5) api.seek(liveT);
          // never call play() on a finished video: that would restart it from 0 before the server says "ended"
          if (s.playing && !playing && !finished) api.play();
          else if (!s.playing && playing) api.pause();
        }
        // autoplay blocked? ask for one click
        if (s.playing && !playing && !finished) {
          wantSince.current ||= Date.now();
          if (Date.now() - wantSince.current > 2500) setNeedTap(true);
        } else {
          wantSince.current = 0;
          setNeedTap(false);
        }
      } else if (s.playing && t > liveT + 0.4) {
        // detached viewers can rewind but never get ahead of a playing host. While the host is paused
        // the host's position is frozen, so viewers are free to watch on their own from there.
        api.seek(liveT);
      }
    }, 400);
    return () => window.clearInterval(id);
  }, [ready]);

  // chat timestamps etc. ask us to jump
  useEffect(
    () =>
      onSeekRequest((t) => {
        const api = apiRef.current;
        if (!api) return;
        if (canRef.current) return seekController(t);
        seekViewer(t);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ready],
  );

  const liveNow = () => computePosition(syncRef.current, serverNow());

  const seekController = (t: number) => {
    apiRef.current?.seek(t);
    suppressUntil.current = Date.now() + 1500;
    send({ t: 'control', action: 'seek', position: t });
  };

  const seekViewer = (t: number) => {
    const api = apiRef.current;
    if (!api) return;
    const target = clampSeek(t, 0, liveNow());
    api.seek(target);
    setAtt(target >= liveNow() - 1.5);
  };

  const toggle = () => {
    const api = apiRef.current;
    if (!api) return;
    lastToggle.current = Date.now();
    const t = api.time();
    if (canControl) {
      suppressUntil.current = Date.now() + 1500;
      if (syncRef.current.playing) {
        api.pause();
        send({ t: 'control', action: 'pause', position: t });
      } else {
        // pressing play on a finished video replays it from the start, for everyone
        const d = api.duration();
        const atEnd = d > 0 && t >= d - 0.5;
        if (atEnd) {
          api.seek(0);
          endedSent.current = false;
        }
        api.play();
        send({ t: 'control', action: 'play', position: atEnd ? 0 : t });
      }
      return;
    }
    if (api.playing()) {
      api.pause();
      setAtt(false);
    } else {
      // A viewer pressing play while the room is paused/finished watches on their own (detached),
      // otherwise the sync loop would immediately pause them again. They can rewatch up to the live point.
      const d = api.duration();
      if (d > 0 && t >= d - 0.5) api.seek(0);
      if (!syncRef.current.playing) setAtt(false);
      api.play();
    }
  };

  const goLive = () => {
    const api = apiRef.current;
    if (!api) return;
    api.seek(liveNow());
    setAtt(true);
    api.setRate(1); // back on the host's timeline means back at normal speed
    setSpeed(1);
    if (syncRef.current.playing) api.play();
  };

  const tap = () => {
    setNeedTap(false);
    const api = apiRef.current;
    if (!api) return;
    api.seek(liveNow());
    setAtt(true);
    api.play();
  };

  // ---- settings menu: quality, audio track, subtitles, speed
  // listening only: a hosted copy drops to its smallest picture to save data (same sound, same timing)
  useEffect(() => {
    if (hlsRef.current && levels.length > 1) hlsRef.current.currentLevel = watchMode === 'audio' ? 0 : level;
  }, [watchMode, levels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickQuality = (i: number) => {
    setLevel(i);
    if (hlsRef.current) hlsRef.current.currentLevel = i; // -1 = automatic
  };
  const pickAudio = (i: number) => {
    setAudioIdx(i);
    if (hlsRef.current) hlsRef.current.audioTrack = i;
  };
  const pickSub = async (i: number) => {
    setSubIdx(i);
    if (i < 0) return setCues(null);
    try {
      const r = await fetch(subTracks[i]!.url);
      setCues(parseSubtitles(await r.text()));
    } catch {
      setCues(null);
    }
  };
  const pickSpeed = (s: number) => {
    setSpeed(s);
    apiRef.current?.setRate(s);
    if (s !== 1) setAtt(false); // a different speed means you are no longer following the host's clock
  };

  // ---- keyboard shortcuts and lock-screen / headphone controls
  const seekBy = (d: number) => {
    const api = apiRef.current;
    if (!api) return;
    const t = Math.max(0, api.time() + d);
    if (canControl) seekController(t);
    else seekViewer(t); // forward seeks are clamped to the live position
  };
  const preMute = useRef(80);
  const toggleMute = () => setVolume((v) => (v > 0 ? ((preMute.current = v), 0) : preMute.current || 80));
  const isPlaying = () => (canControl ? syncRef.current.playing : !!apiRef.current?.playing());
  usePlayerShortcuts({
    toggle,
    seekBy,
    volumeBy: (d) => setVolume((v) => Math.min(100, Math.max(0, v + d))),
    mute: toggleMute,
    fullscreen: onFullscreen,
    subtitles: () => (subTracks.length ? void pickSub(subIdx >= 0 ? -1 : 0) : cues ? setCues(null) : undefined),
  });
  const ytNow = youtubeIdOf(sync);
  useMediaSession({
    title: sync.title ?? title,
    artwork: ytNow ? `https://i.ytimg.com/vi/${ytNow}/hqdefault.jpg` : undefined,
    onNext: canControl ? () => send({ t: 'queueNext' }) : undefined,
    onPrev: canControl ? () => send({ t: 'queuePrev' }) : undefined,
    playing: canControl ? sync.playing : playingLocal,
    onPlay: () => !isPlaying() && toggle(),
    onPause: () => isPlaying() && toggle(),
    onSeekBy: seekBy,
  });

  // everyone sees the whole video; viewers cannot seek past the host, nobody past what is converted yet
  // (both parts are drawn dimmer on the bar)
  const max = Math.max(dur, fullDur, live, 0.1);
  const converting = fullDur > dur + 1;
  const seekLimit = canControl ? (converting ? dur : undefined) : converting ? Math.min(live, dur) : live;
  const atLive = attached || canControl;

  return (
    <div className="stage-inner">
      {/* double-click anywhere on the picture (buttons included, like YouTube) toggles fullscreen */}
      <div className="video-area" onDoubleClick={onFullscreen}>
        {sync.kind === 'youtube' ? <div className="yt-holder" ref={holderRef} /> : <div className="video-slot" ref={slotRef} />}
        {switching && copyOfYoutube && (
          <div className="switch-cover" aria-live="polite">
            <img src={`https://i.ytimg.com/vi/${copyOfYoutube}/hqdefault.jpg`} alt="" />
            <span>Switching to full quality…</span>
          </div>
        )}
        {(audioOnly || watchMode === 'audio') && (
          <NowPlayingArt
            title={sync.title ?? (title !== 'Couchline' ? title : 'Now playing')}
            videoId={youtubeIdOf(sync)}
            playing={playingLocal}
            next={upNextTitle}
          />
        )}
        {!audioOnly && (
          <div className="watch-switch" role="group" aria-label="Watch the video or just listen">
            <button className={watchMode === 'video' ? 'on' : ''} aria-pressed={watchMode === 'video'} onClick={() => pickWatch('video')}>
              🎬 Video
            </button>
            <button className={watchMode === 'audio' ? 'on' : ''} aria-pressed={watchMode === 'audio'} onClick={() => pickWatch('audio')}>
              🎵 Audio
            </button>
          </div>
        )}
        <div className="shield" onPointerMove={wakeTap} onClick={wakeTap} title="Double-click for fullscreen" />
        <TapControls shown={tapShown} playing={canControl ? sync.playing : playingLocal} onToggle={toggle} onSeekBy={seekBy} onWake={wakeTap} onFullscreen={onFullscreen} />
        {soundBlocked && (
          <button
            className="sound-btn"
            onClick={() => {
              const v = videoRef.current;
              if (v) {
                v.muted = false;
                void v.play().catch(() => undefined);
              }
              setSoundBlocked(false);
            }}
          >
            🔇 Tap for sound
          </button>
        )}
        <SubtitleOverlay cues={cues} time={cur} />
        {loadError && <div className="overlay-msg">{loadError}</div>}
        {!loadError && sync.kind === 'site' && <div className="overlay-msg">⬇️ Getting this video ready…</div>}
        {!loadError && needTap && (
          <button className="overlay-btn" onClick={tap}>
            ▶ Click to join playback
          </button>
        )}
      </div>
      <Controls
        playing={canControl ? sync.playing : playingLocal}
        current={cur}
        min={0}
        max={max}
        atLive={atLive}
        liveMode={!canControl}
        behind={Math.max(0, live - cur)}
        limit={seekLimit}
        volume={volume}
        onToggle={toggle}
        onSeek={canControl ? seekController : seekViewer}
        onGoLive={goLive}
        onVolume={setVolume}
        onFullscreen={onFullscreen}
        onCues={setCues}
        hasCues={cues !== null}
        extra={
          <>
            {canControl && (
              <button className="icon" title="Previous video" aria-label="Previous video" disabled={!hasPrevious} onClick={() => send({ t: 'queuePrev' })}>
                ⏮
              </button>
            )}
            {canControl && (
              <button className="icon" title="Play next in queue" onClick={() => send({ t: 'queueNext' })}>
                ⏭
              </button>
            )}
            <SettingsMenu
              qualities={levels}
              quality={level}
              autoLabel={autoHeight ? `${autoHeight}p` : ''}
              onQuality={pickQuality}
              audio={audioNames.map((n, i) => ({ name: namedAudio[i] ?? n }))}
              audioIdx={audioIdx}
              onAudio={pickAudio}
              subs={subTracks}
              subIdx={subIdx}
              onSub={(i) => void pickSub(i)}
              speed={speed}
              onSpeed={pickSpeed}
              speedEnabled={!canControl}
            />
          </>
        }
      />
    </div>
  );
}

/** Music: the song's cover (its YouTube thumbnail) over a blurred copy of it, the title, and what plays next. */
function NowPlayingArt({ title, videoId, playing, next }: { title: string; videoId: string | null; playing: boolean; next: string | null }) {
  const cover = videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null;
  return (
    <div className="np-art" aria-label={`Now playing: ${title}`}>
      {cover && <div className="np-bg" style={{ backgroundImage: `url(${cover})` }} />}
      <div className="np-card">
        <div className="np-cover">{cover ? <img src={cover} alt="" /> : <span className="np-note">♪</span>}</div>
        <div className="np-text">
          <span className={`eq${playing ? ' on' : ''}`} aria-hidden>
            <i />
            <i />
            <i />
          </span>
          <b>{title}</b>
          {next && <span className="np-next">Up next · {next}</span>}
        </div>
      </div>
    </div>
  );
}
