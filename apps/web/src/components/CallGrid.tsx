import { useEffect, useRef, useState } from 'react';
import { useRoom } from '../lib/room';
import { useCall } from '../lib/call';

/** Camera tiles for everyone in voice, shown under the player. Renders nothing until someone is in voice. */
export function CallGrid() {
  const inVoice = useCall((s) => s.inVoice);
  const camera = useCall((s) => s.camera);
  const remote = useCall((s) => s.remote);
  const remoteCam = useCall((s) => s.remoteCam);
  const me = useRoom((s) => s.me);
  const members = useRoom((s) => s.members);
  const others = members.filter((m) => m.voice && m.id !== me?.id);
  if (!inVoice && others.length === 0) return null;

  return (
    <div className="call-grid">
      {inVoice && <Tile name={`${me?.nick ?? 'You'} (you)`} track={camera} sending={camera !== null} mine />}
      {others.map((m) => (
        <Tile key={m.id} name={m.nick} track={remote[m.id] ?? null} sending={!!remoteCam[m.id]} />
      ))}
    </div>
  );
}

/** One person: their camera when it is switched on and sending frames, otherwise an initial. */
function Tile({ name, track, sending, mine }: { name: string; track: MediaStreamTrack | null; sending: boolean; mine?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!track || !v) {
      setLive(false);
      return;
    }
    v.srcObject = new MediaStream([track]);
    // a remote camera that is off arrives as a muted track; it unmutes when frames start flowing.
    // The events are the fast path; re-reading the flag twice a second catches any change they miss.
    const sync = () => setLive(!track.muted && track.readyState === 'live');
    sync();
    track.addEventListener('mute', sync);
    track.addEventListener('unmute', sync);
    track.addEventListener('ended', sync);
    const poll = window.setInterval(sync, 500);
    return () => {
      window.clearInterval(poll);
      track.removeEventListener('mute', sync);
      track.removeEventListener('unmute', sync);
      track.removeEventListener('ended', sync);
      v.srcObject = null;
    };
  }, [track]);

  const on = sending && live;
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div className={`call-tile${on ? ' live' : ''}${mine ? ' mine' : ''}`}>
      <video ref={ref} autoPlay playsInline muted />
      {!on && <span className="call-avatar" aria-hidden>{initial}</span>}
      <span className="call-name">{name}</span>
    </div>
  );
}
