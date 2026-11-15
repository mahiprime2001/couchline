# Couchline

Watch videos together in a room, like a Discord channel. No accounts, no database, nothing stored.

- **Link mode:** paste a YouTube link (or a direct .mp4/.webm/.mov link). Everyone stays in sync.
- **Host stream:** the host plays a file from their own computer (or shares a tab/screen) and it streams peer to peer (WebRTC) to the viewers. The server only relays the handshake.
- **Live, rewind-only:** viewers can go back, never ahead of the host. A "Go live" button jumps back.
- **Rooms:** chat (memory only, gone when the room closes), people list, roles (host/mod), kick/mute, lock + password, queue with voting, polls, reactions, voice chat, subtitles, QR invite.

## Run it locally

All you need on the machine is **Node.js 20+** (Windows, Linux or macOS, x64 or ARM). Everything else is fetched for that machine:

```bash
corepack enable        # gives you pnpm (comes with Node)
pnpm install           # also installs ffmpeg + ffprobe for this OS / CPU (npm packages ffmpeg-static, @ffprobe-installer/ffprobe)
pnpm setup-tools       # downloads yt-dlp and cloudflared for this OS / CPU into tools/ (git-ignored)
pnpm dev               # web on http://localhost:5173 + the Node rooms backend on :8787
pnpm dev:cf            # same, but with the Cloudflare Worker (wrangler) as the backend instead
```

The tools are never committed: `tools/` is git-ignored, and the big binaries come from their official releases (yt-dlp and cloudflared from their GitHub releases, ffmpeg/ffprobe from npm). The server picks each tool in this order and prints what it chose at start-up: an environment variable (`FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH`), then `tools/` (you can drop your own portable builds there, e.g. `tools/ffmpeg/ffmpeg.exe`), then the npm packages, then whatever is on the system PATH. A yt-dlp in `tools/` updates itself every time the server starts, because YouTube changes often and an old yt-dlp stops working.

The default backend is a plain Node server (`apps/server`): one process, nothing hidden, rooms stay alive while you edit the web app. The Cloudflare worker (`apps/worker`) runs the exact same room code (`packages/room`) and is the option for hosting on Cloudflare.

If `pnpm dev` says a port is in use, an old dev process is still running (on Windows, Ctrl+C sometimes leaves one behind). Stop it, or use the port Vite prints.

Open http://localhost:5173, make a room, then open the invite link in a second browser window (or another browser) to be the viewer.

Tips for testing alone: use two different browser profiles, or one normal window and one incognito window (each tab keeps its own session).

### A temporary HTTPS link (for phones, other computers, screen share and the microphone)

Browsers only allow screen sharing and the microphone on `https://` pages or `http://localhost`. With `pnpm dev` running, in a second terminal run:

```bash
pnpm tunnel       # prints https://<random-words>.trycloudflare.com
```

Open that address on any device, from any network. It is a free Cloudflare quick tunnel: no account, the address changes every time and stops when you close the terminal. Only the page and the room messages go through the tunnel; the video itself still goes directly between the browsers. `pnpm setup-tools` puts the official cloudflared for your OS in `tools/cloudflared` (ignored by git); an installed `cloudflared` works too. For `pnpm start` (everything on one port) use `pnpm tunnel -- 8787`. Anyone who has the address can open the site, so share it only with people you want in your rooms.

## Upload & host (YouTube-style, any format)

The host can press **☁️ Upload & host (any format)** in the room. The file goes to the server, **ffmpeg** cuts it into short chunks (HLS) and everyone plays those chunks, so any audio or video format works on every device, with sound. Playback starts as soon as the first chunks are ready while the rest keeps converting.

- **Needs the Node backend.** ffmpeg + ffprobe come with `pnpm install` (see above). The Cloudflare Worker backend cannot run ffmpeg, so there the button is disabled with an explanation.
- **Fast when it can be:** H.264 video is copied, not re-encoded, and sound is always converted to AAC (this is what fixes AC3/DTS files). Other video (HEVC, AV1, old codecs) is re-encoded to H.264, which depends on the server's CPU.
- **Not stored for long:** files live in `apps/server/.media`, are deleted when the room closes, after `MEDIA_TTL_HOURS` (default 6), when a room has more than its 8 most recent videos (`MEDIA_PER_ROOM`), and on every server restart.
- **Limits (environment variables):** `MAX_UPLOAD_MB` (default 4096), `MAX_MEDIA_GB` total (default 20), one conversion at a time.
- **Several qualities and audio tracks.** A source taller than 360p is converted into 1080/720/480/360p (only the ones at or below its own size), and every audio track in the file becomes a selectable track, named from the file's own tags (for example "English", "Hindi commentary"). Text subtitles are extracted as WebVTT. Set `MEDIA_QUALITIES=original` to keep one quality only, which is much cheaper for a weak server (several qualities means several video encodes at once).
- **Player menu (⚙️):** quality (Auto or a fixed size), audio track, subtitles, and playback speed for viewers. Speed puts a viewer on their own timeline; "Go live" brings them back.

## More player and room tools

- **Keyboard shortcuts:** Space/K play-pause, ←/J back 5 s, →/L forward 5 s, ↑/↓ volume, M mute, F fullscreen, C subtitles. Viewers can still never go forward past the host.
- **Lock-screen, notification and headphone/media-key controls** (Media Session API) with the video's title.
- **Queue:** shuffle, and repeat (off / loop the list / repeat this video). Host and mods control both.
- **Appearance:** light or dark theme and an accent colour (Room tab). Saved in your browser only.
- **Only the host can upload** (checked with the room's secret host token). Hosted videos are played through the same synced, rewind-only player as links.
- **This uses the server's disk and bandwidth** (every viewer downloads the chunks from it), unlike streaming from the host's computer, which goes browser to browser. You also host whatever people upload, so think about abuse and copyright before opening it to strangers.

## Tests

```bash
pnpm test         # unit tests (shared logic)
pnpm typecheck
pnpm smoke        # WebSocket protocol checks; needs `pnpm dev` running
pnpm e2e          # real Chrome: link mode + host-stream mode; needs `pnpm dev` and Chrome/Edge installed
```

## Room lifetime

| Mode | Host leaves | Room closes |
|---|---|---|
| Link | Host rights pass to the longest-present member; the original host can reclaim | 5 min after the room is empty |
| Stream | Stream pauses ("host away"), viewers keep what they buffered; the host can resume from the saved position | 20 min after the room is empty |

## Limits (by design)

- **Host-stream is Chromium-only** (Chrome, Edge, Brave on desktop). It needs `MediaRecorder` + `MediaSource` + `captureStream()`.
- **Host upload bandwidth** is the ceiling: each viewer gets their own copy from the host. The cap is 8 viewers per streamed room. Quality presets: 0.8 / 1.5 / 2.5 Mbps; the app lowers it automatically if a viewer can't keep up.
- **Rewind buffer** is kept in each viewer's memory, up to 30 minutes. A refresh loses it. Late joiners can rewind to the moment they joined.
- **Behind strict NATs/firewalls** a direct connection can fail. Configure TURN (below).
- **YouTube** must allow embedding. Vimeo and other sites are not supported.
- Kick/ban applies to the browser tab's session; someone can rejoin from a new tab unless the room is locked or has a password.

## Deploy (when you're ready)

**Option A: any machine or VPS (Node 20+), one process.** It serves the web app and the rooms backend together:

```bash
pnpm install
pnpm start        # builds the web app, then runs the server on http://0.0.0.0:8787  (PORT=80 pnpm start to change)
```

Put it behind HTTPS (Caddy, nginx, or a host like Render/Railway/Fly). HTTPS is required in production for the microphone, screen share and the file picker. Rooms live in that process's memory, so restarting it closes every room.

**Option B: Cloudflare (serverless, free tier):**

```bash
npx wrangler login
pnpm deploy       # builds the web app, deploys the Worker + Durable Object + static assets
```

Optional TURN relay (recommended for real use), using Cloudflare Calls TURN:

```bash
cd apps/worker
npx wrangler secret put TURN_KEY_ID -c wrangler.deploy.toml
npx wrangler secret put TURN_API_TOKEN -c wrangler.deploy.toml
```

## Layout

```
apps/web       React + Vite UI, WebRTC host streamer / viewer receiver, voice
apps/server    Node backend (default): HTTP API + WebSocket rooms + serves the built web app
apps/worker    Cloudflare backend: Worker + Durable Object wrapper around the same room code
packages/room  the room logic itself (sync, chat, queue, polls, roles, signalling), backend-agnostic
packages/shared  message protocol (Zod), sync maths, link allowlist, subtitle parser
scripts        smoke + real-browser e2e tests
TASKS.md       task pipeline with honest status
```
