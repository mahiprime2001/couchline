import { useEffect, useRef, useState } from 'react';
import { useRoom } from '../lib/room';
import { useCall } from '../lib/call';

type Muted = 'organizer' | 'self' | null;

const MUTED_TITLE: Record<Exclude<Muted, null>, string> = {
  organizer: 'Muted by the host or an organizer',
  self: 'Microphone off',
};

/** Camera tiles for everyone in voice, shown under the player. Renders nothing until someone is in voice. */
export function CallGrid() {
  const inVoice = useCall((s) => s.inVoice);
  const camera = useCall((s) => s.camera);
  const remote = useCall((s) => s.remote);
  const remoteCam = useCall((s) => s.remoteCam);
  const micOff = useCall((s) => s.micOff);
  const speaking = useCall((s) => s.speaking);
  const me = useRoom((s) => s.me);
  const members = useRoom((s) => s.members);
  const others = members.filter((m) => m.voice && m.id !== me?.id);
  if (!inVoice && others.length === 0) return null;

  const mutedOf = (id: string | undefined, byOrganizer: boolean | undefined): Muted =>
    byOrganizer ? 'organizer' : id && micOff[id] ? 'self' : null;

  return (
    <div className="call-grid">
      {inVoice && (
        <Tile
          name={`${me?.nick ?? 'You'} (you)`}
          track={camera}
          sending={camera !== null}
          mine
          muted={mutedOf(me?.id, me?.muted)}
          speaking={!!me && !!speaking[me.id]}
        />
      )}
      {others.map((m) => (
        <Tile
          key={m.id}
          name={m.nick}
          track={remote[m.id] ?? null}
          sending={!!remoteCam[m.id]}
          muted={mutedOf(m.id, m.muted)}
          speaking={!!speaking[m.id]}
        />
      ))}
    </div>
  );
}

/** One person: their camera when it is switched on and sending frames, otherwise an initial. */
function Tile({
  name,
  track,
  sending,
  mine,
  muted,
  speaking,
}: {
  name: string;
  track: MediaStreamTrack | null;
  sending: boolean;
  mine?: boolean;
  muted: Muted;
  speaking: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!track || !v) {
      setLive(false);
      return;
    }
    v.srcObject = new MediaStream([track]);
    // the camera's on/off state arrives as a message (sending), so the track only needs to be running here.
    // The events are the fast path; re-reading the state twice a second catches any change they miss.
    const sync = () => setLive(track.readyState === 'live');
    sync();
    track.addEventListener('ended', sync);
    const poll = window.setInterval(sync, 500);
    return () => {
      window.clearInterval(poll);
      track.removeEventListener('ended', sync);
      v.srcObject = null;
    };
  }, [track]);

  const on = sending && live;
  const initial = name.trim().charAt(0).toUpperCase() || '?';
  return (
    <div className={`call-tile${on ? ' live' : ''}${mine ? ' mine' : ''}${speaking ? ' speaking' : ''}`}>
      <video ref={ref} autoPlay playsInline muted />
      {!on && <span className="call-avatar" aria-hidden>{initial}</span>}
      {muted && (
        <span className="call-muted" role="img" aria-label={MUTED_TITLE[muted]} title={MUTED_TITLE[muted]}>
          🔇
        </span>
      )}
      <span className="call-name">{name}</span>
    </div>
  );
}
