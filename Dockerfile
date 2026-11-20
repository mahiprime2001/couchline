# Couchline in one container: the Node server hosts the web app, the rooms, voice, cameras and host streams on 8787.
# Put it behind https (see deploy/): browsers only allow the microphone, the camera and screen sharing on https pages.
#   docker build -t couchline .
#   docker run -p 8787:8787 -v couchline-media:/data/media couchline
FROM node:22-bookworm-slim

WORKDIR /app
RUN corepack enable

# dependencies first, so a code change does not reinstall them (ffmpeg and ffprobe for Linux come with these)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/room/package.json packages/room/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile

COPY . .
# the web app, and yt-dlp for Linux (no cloudflared: this server is reached directly, not through a tunnel)
RUN pnpm build && node scripts/setup-tools.mjs --yt-dlp-only

ENV PORT=8787 HOST=0.0.0.0 MEDIA_DIR=/data/media
EXPOSE 8787
VOLUME /data/media
CMD ["pnpm", "--filter", "@wp/server", "start"]
