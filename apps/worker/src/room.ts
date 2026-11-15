import { RoomCore, type WebSocketLike } from '@wp/room';
import type { Env } from './env';

/** Cloudflare Durable Object: one per room code. A thin wrapper; the room logic lives in @wp/room. */
export class Room implements DurableObject {
  private core: RoomCore;

  constructor(state: DurableObjectState, _env: Env) {
    this.core = new RoomCore({
      setAlarm: (ms) => void state.storage.setAlarm(Date.now() + ms),
      clearAlarm: () => void state.storage.deleteAlarm(),
    });
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
    this.core.setCode(new URL(req.url).pathname.slice(1));
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.core.attach(server as unknown as WebSocketLike);
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    this.core.onAlarm();
  }
}
