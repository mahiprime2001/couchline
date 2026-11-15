# Watch-Party App: Task Pipeline

Stack: React + Vite + TS + Tailwind (web) / Cloudflare Workers + Durable Objects (rooms) / WebRTC (host-stream) / pnpm monorepo.
Rules: no logins, no database, chat and room state in memory only, destroyed when the room closes.

Legend: [ ] not done, [~] implemented but NOT verified (no automated or manual test yet), [x] done and verified (unit tests, WebSocket smoke test, or real-Chrome e2e). Each task has a "Done when" check.

---

## Phase 0: Risk prototype (throwaway, `prototype/`)
Prove the riskiest piece first: host file -> MediaRecorder -> DataChannel -> MSE -> rewind-only player.

- [x] 0.1 Two-tab localhost page: host picks a file, `captureStream()` plays locally. Done when: stream object produced.
- [x] 0.2 MediaRecorder 1s chunks + init segment, sent over a loopback RTCDataChannel with backpressure. Done when: viewer receives ordered chunks.
- [x] 0.3 Viewer MSE player appends chunks, tracks live edge. Done when: video plays ~1-3s behind host.
- [x] 0.4 Rewind-only clamp: forward seeks snap to live edge, "Go live" button. Done when: can't seek past edge.
- [ ] 0.5 Measure: latency, host CPU at 480p/720p, viewer RAM per 10 min. Done when: numbers recorded, go/no-go decision made.
- [~] 0.6 Late-join test (init segment replay) and pause-then-resume behind live. Done when: both work.

**Gate:** if 0.5 fails (latency >5s or unstable), reconsider the design before Phase 3.

## Phase 1: Foundation
- [x] 1.1 pnpm monorepo: `apps/web`, `apps/worker`, `packages/shared`; TS, ESLint, Prettier.
- [x] 1.2 Shared message protocol (Zod schemas) for all WebSocket messages.
- [x] 1.3 Worker + `Room` Durable Object skeleton; create/join room by code; WebSocket upgrade.
- [x] 1.4 Room state machine: LINK_ACTIVE, STREAM_LIVE, STREAM_HOST_AWAY, CLOSED, with alarm-based grace timers.
- [x] 1.5 Anonymous join: nickname prompt, session id, host token kept in browser storage.
- [x] 1.6 Presence list, join/leave notices, reconnect handling.
- [x] 1.7 Web shell: landing (create/join), room layout, routing.
- [x] 1.8 Dev setup: `wrangler dev` + Vite proxy; one-command local run.

Done when: two browsers join one room and see each other; closing the last tab destroys the room after the grace period.

## Phase 2: Link mode
- [x] 2.1 Link parser + allowlist (YouTube, Vimeo, direct video files).
- [~] 2.2 Player wrapper: YouTube IFrame API + react-player, custom controls.
- [x] 2.3 Sync record `{url, playing, position, updatedAt}` in the DO; extrapolate current time.
- [x] 2.4 Host controls: play, pause, seek, change video broadcast to all.
- [x] 2.5 Drift correction (re-seek if off by >1.5s).
- [x] 2.6 Rewind-only rule: viewer seeks clamped to host position.
- [x] 2.7 Host-less continuation: host handoff (or shared controls), host reclaim via token.
- [x] 2.8 Queue: suggest links, host approve, reorder, auto-advance.

Done when: 3 browsers watch the same YouTube video in sync; the host leaves and the room keeps playing.

## Phase 3: Chat and roles
- [x] 3.1 Ephemeral chat (in-memory buffer of last ~50, rate-limited, length-capped).
- [~] 3.2 Typing indicator, chat timestamps clickable (rewind-only jump).
- [x] 3.3 Roles: host, moderator, viewer; promote/demote.
- [x] 3.4 Kick, mute; room lock; optional room password.
- [~] 3.5 Report button + basic spam/profanity filter.

Done when: chat works across clients and leaves nothing behind after the room closes.

## Phase 4: Host-stream mode
- [x] 4.1 Host UI: choose file, preview, start stream, bitrate/resolution cap.
- [x] 4.2 Signaling over the room DO: offers/answers/ICE per viewer.
- [x] 4.3 Per-viewer RTCPeerConnection + DataChannel; viewer cap (default 8).
- [x] 4.4 Chunk pipeline (from the prototype), production-hardened: backpressure, reordering, error recovery.
- [x] 4.5 Viewer MSE player: rewind-only controls, LIVE badge, Go-live, buffer eviction (30 min cap).
- [x] 4.6 Late joiner: init segment replay, starts at live edge.
- [x] 4.7 Host disconnect: STREAM_HOST_AWAY banner, viewers keep their buffer.
- [x] 4.8 Host resume: record file position, File System Access reopen, name/size check, continue timeline.
- [~] 4.9 TURN fallback (Cloudflare TURN or coturn) with credentials from the Worker.
- [~] 4.10 Adaptive quality for host upload; per-viewer lag/health indicator.
- [~] 4.11 Mode switch: host converts a stream room to link mode and back.

Done when: host streams a local file to 3 viewers on different networks; viewers can rewind but not skip ahead; host reconnects and resumes.

## Phase 5: Extras (pick per priority)
- [~] 5.1 Floating emoji reactions.
- [x] 5.2 Queue voting.
- [~] 5.3 Invite link + QR code.
- [~] 5.4 Subtitles (.srt/.vtt) loading.
- [x] 5.5 Pop-up polls.
- [~] 5.6 Voice chat (push-to-talk / mute).
- [~] 5.7 Screen/tab share as a stream source.
- [~] 5.8 Optional chat-log download before room close.

## Phase 6: Polish and quality
- [~] 6.1 UI design pass (dark theme, responsive, mobile layout, theater mode).
- [ ] 6.2 Accessibility pass (keyboard controls, captions, contrast).
- [x] 6.3 Unit tests: protocol, state machine, clamp logic. Target 80%+ on shared and worker.
- [x] 6.4 E2E tests (Playwright, multi-context): join, sync, chat, stream, rewind clamp, host-away/resume.
- [ ] 6.5 Security review: input validation, rate limits, link allowlist, room-code entropy, abuse paths.
- [~] 6.6 Browser support banner (Chromium-only for host-stream) and graceful fallbacks.

## Phase 7: Ship
- [ ] 7.1 Cloudflare deploy (Worker + static assets), custom domain.
- [ ] 7.2 TURN credentials and secrets configuration.
- [ ] 7.3 Observability: basic logs/metrics, error reporting.
- [x] 7.4 README, usage limits doc, abuse/report policy.
- [ ] 7.5 Load test: many rooms, 8 viewers/room stream room.

---

## Dependency order
0 (prototype gate) -> 1 -> 2 -> 3 -> 4 -> 5 / 6 (parallel) -> 7
Phases 2 and 3 can overlap once 1.3 and 1.4 land.

## Decisions made
- Host-less link rooms: host rights pass to the longest-present member; the original host reclaims with their token.
- Grace periods: 5 min (link rooms), 20 min (stream rooms), counted from when the room is empty.
- All Phase 5 extras are built, but only voice/QR/subtitles/reactions/screen-share/chat-export still need a manual check in the browser.

## Not done yet
- 0.5 latency/CPU/RAM measurements (functionally works; numbers not recorded)
- 6.2 accessibility pass, 6.5 security review
- 7.1-7.3, 7.5 deploy, secrets, observability, load test (you said you'll host after local testing)
- Real YouTube playback (needs a manual check; automated tests used a direct video file)
