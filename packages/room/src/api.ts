// Small HTTP helpers shared by every backend (Cloudflare Worker and Node server).

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 6 characters from a 32-letter alphabet without look-alikes: about a billion codes. */
export function makeCode(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

export interface IceEnv {
  TURN_KEY_ID?: string | undefined;
  TURN_API_TOKEN?: string | undefined;
}

/** STUN always; plus a Cloudflare TURN relay when TURN_KEY_ID / TURN_API_TOKEN are configured. */
export async function iceServers(env: IceEnv): Promise<{ iceServers: unknown[]; turn: boolean }> {
  const stun = { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] };
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.TURN_API_TOKEN}`, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: 86400 }),
        },
      );
      if (res.ok) {
        const body = (await res.json()) as { iceServers?: unknown[] };
        if (Array.isArray(body.iceServers)) return { iceServers: body.iceServers, turn: true };
      }
    } catch {
      /* fall through to STUN only */
    }
  }
  return { iceServers: [stun], turn: false };
}
