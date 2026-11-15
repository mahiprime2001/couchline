// `pnpm tunnel`: share the app over https with a Cloudflare quick tunnel (https://<random>.trycloudflare.com),
// using tools/cloudflared from `pnpm setup-tools`, or a cloudflared installed on the PATH.
//   pnpm tunnel                 (points at the dev server, http://localhost:5173)
//   pnpm tunnel -- 8787         (another port, e.g. `pnpm start`, which serves everything on 8787)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const local = join(ROOT, 'tools', 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
const bin = existsSync(local) ? local : 'cloudflared';
const port = process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? '5173';

const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], { stdio: 'inherit' });
child.on('error', () => {
  console.error('cloudflared not found. Run `pnpm setup-tools` first (or install cloudflared).');
  process.exit(1);
});
child.on('exit', (code) => process.exit(code ?? 0));
