import { useEffect, useState } from 'react';
import { REACTIONS } from '@wp/shared';
import { onReaction, send } from '../lib/room';

interface Floater {
  id: number;
  emoji: string;
  nick: string;
  left: number;
}

let counter = 0;

/** Floating emoji layer, drawn over the video. */
export function ReactionLayer() {
  const [items, setItems] = useState<Floater[]>([]);

  useEffect(
    () =>
      onReaction((emoji, nick) => {
        const id = ++counter;
        setItems((cur) => [...cur.slice(-30), { id, emoji, nick, left: 8 + Math.random() * 84 }]);
        window.setTimeout(() => setItems((cur) => cur.filter((f) => f.id !== id)), 3200);
      }),
    [],
  );

  return (
    <div className="reaction-layer" aria-hidden>
      {items.map((f) => (
        <span key={f.id} className="floater" style={{ left: `${f.left}%` }} title={f.nick}>
          {f.emoji}
        </span>
      ))}
    </div>
  );
}

export function ReactionBar() {
  return (
    <div className="reaction-bar">
      {REACTIONS.map((e) => (
        <button key={e} className="emoji" onClick={() => send({ t: 'reaction', emoji: e })} aria-label={`React ${e}`}>
          {e}
        </button>
      ))}
    </div>
  );
}
