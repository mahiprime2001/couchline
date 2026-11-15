import { iceServers, makeCode } from '@wp/room';
import { Room } from './room';
import type { Env } from './env';

export { Room };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/api/health') return json({ ok: true, backend: 'cloudflare' });

    if (url.pathname === '/api/rooms' && req.method === 'POST') {
      return json({ code: makeCode() });
    }

    if (url.pathname === '/api/ice') return json(await iceServers(env));

    const m = url.pathname.match(/^\/ws\/([A-Z0-9]{4,10})$/);
    if (m) {
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
      const code = m[1]!;
      const stub = env.ROOM.get(env.ROOM.idFromName(code));
      return stub.fetch(new Request(`https://room/${code}`, req));
    }

    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response('Not found', { status: 404 });
  },
};
