import { useEffect, useRef, useState } from 'react';
import { getIceServers, onSignal, send, useRoom } from '../lib/room';
import { useCall } from '../lib/call';
import { VoiceManager } from '../lib/voice';

/** Join/leave the voice channel, mute, camera, and push-to-talk (hold V). */
export function VoiceBar() {
  const me = useRoom((s) => s.me);
  const members = useRoom((s) => s.members);
  const voiceIds = members.filter((m) => m.voice).map((m) => m.id);
  const containerRef = useRef<HTMLDivElement>(null);
  const mgrRef = useRef<VoiceManager | null>(null);
  const [inVoice, setInVoice] = useState(false);
  const [muted, setMuted] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [ptt, setPtt] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pttRef = useRef(false);
  pttRef.current = ptt;
  const mutedRef = useRef(false);
  const joiningRef = useRef(false);
  const aliveRef = useRef(true);
  mutedRef.current = muted;

  useEffect(
    () =>
      onSignal((from, data) => {
        if (typeof data?.kind === 'string' && data.kind.startsWith('voice-')) void mgrRef.current?.handleSignal(from, data);
      }),
    [],
  );

  useEffect(() => {
    if (inVoice) mgrRef.current?.reconcile(voiceIds);
  }, [inVoice, voiceIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // mic gating: muted, or push-to-talk (hold V)
  useEffect(() => {
    if (!inVoice) return;
    mgrRef.current?.setMicEnabled(!muted && !ptt);
    if (!ptt) return;
    const typing = (e: KeyboardEvent) => ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName);
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'v' && !typing(e) && !mutedRef.current) mgrRef.current?.setMicEnabled(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'v') mgrRef.current?.setMicEnabled(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [inVoice, muted, ptt]);

  useEffect(
    () => () => {
      aliveRef.current = false;
      mgrRef.current?.leave();
      useCall.getState().reset();
    },
    [],
  );

  const join = async () => {
    if (!me || !containerRef.current || joiningRef.current) return;
    joiningRef.current = true;
    setError(null);
    try {
      const mgr = new VoiceManager({
        myId: me.id,
        iceServers: await getIceServers(),
        signal: (to, data) => send({ t: 'signal', to, data }),
        container: containerRef.current,
        onRemoteVideo: (id, track) => useCall.getState().setRemote(id, track),
        onRemoteCam: (id, on) => useCall.getState().setRemoteCam(id, on),
      });
      // camera on last time: ask for microphone and camera together, once
      await mgr.join(localStorage.getItem('wp-cam') === '1');
      if (!aliveRef.current) return mgr.leave();
      setCamOn(mgr.camera !== null);
      useCall.getState().setCamera(mgr.camera);
      mgrRef.current = mgr;
      setInVoice(true);
      useCall.getState().setInVoice(true);
      send({ t: 'voice', on: true });
    } catch {
      setError('Microphone unavailable or permission denied.');
    } finally {
      joiningRef.current = false;
    }
  };

  const leave = () => {
    mgrRef.current?.leave();
    mgrRef.current = null;
    setInVoice(false);
    setCamOn(false);
    useCall.getState().reset();
    send({ t: 'voice', on: false });
  };

  const toggleCamera = async () => {
    const mgr = mgrRef.current;
    if (!mgr) return;
    setError(null);
    try {
      await mgr.setCamera(!camOn);
      setCamOn(!camOn);
      localStorage.setItem('wp-cam', camOn ? '0' : '1');
      useCall.getState().setCamera(mgr.camera);
    } catch {
      setError('Camera unavailable or permission denied.');
    }
  };

  return (
    <div className="voicebar">
      <div ref={containerRef} hidden />
      {!inVoice ? (
        <button onClick={join}>🎙️ Join voice{voiceIds.length > 0 ? ` (${voiceIds.length})` : ''}</button>
      ) : (
        <>
          <button className={muted ? 'danger' : 'primary'} onClick={() => setMuted((m) => !m)}>
            {muted ? '🔇 Muted' : '🎙️ Live'}
          </button>
          <button className={camOn ? 'primary' : ''} onClick={toggleCamera} title={camOn ? 'Turn your camera off' : 'Show your camera to the room'}>
            {camOn ? '📷 Camera on' : '📷 Camera off'}
          </button>
          <label className="check small">
            <input type="checkbox" checked={ptt} onChange={(e) => setPtt(e.target.checked)} />
            Push-to-talk (hold V)
          </label>
          <button onClick={leave}>Leave voice</button>
        </>
      )}
      {error && <span className="warn small">{error}</span>}
    </div>
  );
}
