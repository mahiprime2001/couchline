// Downloads the command-line tools the server and `pnpm tunnel` use, in the build that fits THIS machine
// (Windows / Linux / macOS, x64 / ARM), into tools/ (git-ignored, so nothing big ends up in the repository):
//   tools/yt-dlp/yt-dlp[.exe]           official standalone build (needs no Python); the server keeps it updated
//   tools/cloudflared/cloudflared[.exe] for `pnpm tunnel` (share the room over https)
// ffmpeg and ffprobe come from npm (ffmpeg-static, @ffprobe-installer/ffprobe) with `pnpm install`, so they are
// not downloaded here. Anything already in tools/ is kept; pass --force to download again.
//   pnpm setup-tools            pnpm setup-tools --force
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS = join(ROOT, 'tools');
const force = process.argv.includes('--force');
const { platform, arch } = process;
const win = platform === 'win32';

/** the release file for this machine, or null when the project publishes none */
const YTDLP = {
  'win32-x64': 'yt-dlp.exe',
  'win32-arm64': 'yt-dlp_arm64.exe',
  'linux-x64': 'yt-dlp_linux',
  'linux-arm64': 'yt-dlp_linux_aarch64',
  'darwin-x64': 'yt-dlp_macos',
  'darwin-arm64': 'yt-dlp_macos',
}[`${platform}-${arch}`];
const CLOUDFLARED = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-arm64': 'cloudflared-windows-amd64.exe', // runs under Windows' x64 emulation
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
}[`${platform}-${arch}`];

async function download(url, dest) {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const tmp = `${dest}.part`;
  writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  renameSync(tmp, dest);
}

async function get(name, asset, repo) {
  const dir = join(TOOLS, name);
  const dest = join(dir, win ? `${name}.exe` : name);
  if (!asset) return console.log(`- ${name}: no ready-made build for ${platform}-${arch}; install it yourself (it is then found on the PATH)`);
  if (existsSync(dest) && !force) return console.log(`- ${name}: already there (${dest})`);
  mkdirSync(dir, { recursive: true });
  const url = `https://github.com/${repo}/releases/latest/download/${asset}`;
  console.log(`- ${name}: downloading ${asset} …`);
  if (asset.endsWith('.tgz')) {
    // macOS cloudflared ships as a .tgz holding a single "cloudflared" binary
    const tgz = join(dir, asset);
    await download(url, tgz);
    execFileSync('tar', ['-xzf', tgz, '-C', dir]);
    rmSync(tgz, { force: true });
  } else {
    await download(url, dest);
  }
  if (!win) chmodSync(dest, 0o755);
  console.log(`  saved ${dest}`);
}

console.log(`Setting up tools for ${platform}-${arch} in ${TOOLS}`);
await get('yt-dlp', YTDLP, 'yt-dlp/yt-dlp');
await get('cloudflared', CLOUDFLARED, 'cloudflare/cloudflared');
console.log('Done. ffmpeg and ffprobe come with `pnpm install`. Start the app with `pnpm start` (or `pnpm dev`).');
