import { useEffect, useRef, useState } from 'react';
import { onMedia, onMediaChunk, send, useRoom } from '../lib/room';
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
  mutedRef.current = muted;

  // In the room, the people in voice are seen and heard straight away: the voice manager starts listening now,
  // and Join voice only adds sending our own microphone and camera.
  const myId = me?.id;
  useEffect(() => {
    const container = containerRef.current;
    if (!myId || !container) return;
    const mgr = new VoiceManager({
      myId,
      container,
      onRemoteVideo: (id, track) => useCall.getState().setRemote(id, track),
      onRemoteCam: (id, on) => useCall.getState().setRemoteCam(id, on),
      // the phone can stop the camera by itself: keep the button and our own tile in step with it
      onCamera: (track) => {
        setCamOn(track !== null);
        useCall.getState().setCamera(track);
      },
    });
    mgr.listen();
    mgrRef.current = mgr;
    return () => {
      mgr.close();
      mgrRef.current = null;
      useCall.getState().reset();
    };
  }, [myId]);

  // from the others in voice, relayed by the room server: small notes (camera on/off, key-frame requests) as
  // messages, and the encoded voice and camera chunks as binary frames
  useEffect(() => onMedia((m) => mgrRef.current?.handleMedia(m)), []);
  useEffect(() => onMediaChunk((c) => mgrRef.current?.handleChunk(c)), []);

  useEffect(() => {
    mgrRef.current?.reconcile(voiceIds);
  }, [myId, voiceIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const join = async () => {
    const mgr = mgrRef.current;
    if (!mgr || joiningRef.current) return;
    joiningRef.current = true;
    setError(null);
    try {
      // camera on last time: ask for microphone and camera together, once
      await mgr.join(localStorage.getItem('wp-cam') === '1');
      if (mgrRef.current !== mgr) return mgr.leave(); // left the room while the browser was asking
      setCamOn(mgr.camera !== null);
      useCall.getState().setCamera(mgr.camera);
      setInVoice(true);
      useCall.getState().setInVoice(true);
      send({ t: 'voice', on: true });
    } catch (e) {
      // a browser without voice support says so; a refused microphone gets the plain message
      const err = e as Error;
      setError(err.name === 'NotAllowedError' || err.name === 'NotFoundError' ? 'Microphone unavailable or permission denied.' : err.message);
    } finally {
      joiningRef.current = false;
    }
  };

  // stops sending our microphone and camera; the others stay visible and audible
  const leave = () => {
    mgrRef.current?.leave();
    setInVoice(false);
    setCamOn(false);
    useCall.getState().setInVoice(false);
    useCall.getState().setCamera(null);
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
