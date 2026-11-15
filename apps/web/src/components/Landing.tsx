import { useState } from 'react';
import { createRoomCode, getNick, setNick } from '../lib/room';

export function Landing({ navigate }: { navigate: (p: string) => void }) {
  const [nick, setNickState] = useState(getNick());
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    if (!nick.trim()) return setError('Pick a nickname first.');
    setBusy(true);
    setError(null);
    try {
      setNick(nick.trim());
      const c = await createRoomCode();
      sessionStorage.setItem(`wp-create-${c}`, '1');
      navigate(`/r/${c}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const join = (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!nick.trim()) return setError('Pick a nickname first.');
    if (c.length < 4) return setError('Room codes are 6 characters.');
    setNick(nick.trim());
    navigate(`/r/${c}`);
  };

  return (
    <div className="landing">
      <div className="hero">
        <b className="logo">▶ Couchline</b>
        <h1>Watch together. Nothing stored.</h1>
        <p className="lead">
          Share YouTube links in sync, or stream a video straight from your own computer. No accounts, no uploads, and the room (chat included) vanishes
          when everyone leaves.
        </p>
      </div>

      <div className="card">
        <label>
          Your nickname
          <input value={nick} onChange={(e) => setNickState(e.target.value)} placeholder="e.g. Alex" maxLength={24} autoFocus />
        </label>
        <button className="primary big" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create a room'}
        </button>
        <div className="or">or join one</div>
        <form onSubmit={join} className="row">
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Room code" maxLength={10} className="code-input" />
          <button type="submit">Join</button>
        </form>
        {error && <p className="warn">{error}</p>}
      </div>

      <ul className="features">
        <li>
          <b>Link mode</b> YouTube and direct video links stay in sync for everyone.
        </li>
        <li>
          <b>Host stream</b> Play a local file or tab; it streams peer to peer from your computer.
        </li>
        <li>
          <b>Live, rewind-only</b> Viewers can go back, never ahead of the host.
        </li>
        <li>
          <b>Rooms like Discord</b> Chat, voice, reactions, queue voting and polls.
        </li>
      </ul>
    </div>
  );
}
