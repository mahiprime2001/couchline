import { z } from 'zod';

export const REACTIONS = ['❤️', '😂', '😮', '👏', '🔥', '😢'] as const;

export const LIMITS = {
  maxMembers: 50,
  maxViewersStream: 8,
  maxVoice: 6,
  chatHistory: 50,
  chatLen: 300,
  queueMax: 200, // room for a whole YouTube playlist
  graceLinkMs: 60_000, // an empty room is wiped after a minute without anyone rejoining
  graceStreamMs: 60_000,
  mediaBacklog: 150_000, // bytes queued for one person (about 2 s of one camera) before their video is skipped; sound is never skipped
  streamBacklog: 4_000_000, // bytes queued for one stream viewer before they are skipped and the host starts afresh for them
  mediaFrame: 256_000, // bytes in one binary voice or camera frame (a key frame of a 640-wide picture is well under this)
  mediaFramesPerSec: 200, // per person: 50 of sound and up to 30 of picture, with room to spare
  mediaChunk: 300_000, // characters of base64 in one encoded audio or video chunk (a key frame can be ~200 KB)
} as const;

/**
 * Voice and camera travel as binary WebSocket frames, not JSON: a fixed header, then the encoded chunk.
 *   [0] kind (MEDIA_AUDIO or MEDIA_VIDEO)   [1] flags (bit 0: key frame)   [2] audio channels   [3] unused
 *   [4..8) chunk number, uint32             [8..12) audio sample rate, uint32
 *   [12..20) timestamp in microseconds, float64        (all little-endian)
 * The server puts the sender in front before passing it on: [0] id length, then the id, then the frame above.
 */
export const MEDIA_HEADER = 20;
export const MEDIA_AUDIO = 1;
export const MEDIA_VIDEO = 2;
/**
 * A piece of the host's own stream (file or screen, recorded as WebM). Header flags: bit 0 last piece of a chunk,
 * bit 1 first piece; the chunk number is in [4..8). From the host, the header is followed by the viewers it is for:
 * [count], then [id length][id] for each. The server removes that list before passing the piece on.
 */
export const MEDIA_STREAM = 3;
export const STREAM_PIECE = 180_000; // bytes of a stream chunk per piece, so every piece fits in one media frame

/** With this many people or fewer in a room, everyone can play, pause, skip and add videos; above it only the host and organizers can. */
export const OPEN_PLAYBACK_MAX_MEMBERS = 3;

/** Who may control playback and the queue. Moderation (kick, mute, roles, polls, room settings) stays with the host and organizers. */
export function canControlPlayback(role: string | undefined, memberCount: number): boolean {
  return role === 'host' || role === 'mod' || memberCount <= OPEN_PLAYBACK_MAX_MEMBERS;
}

const position = z.number().finite().min(0).max(1_000_000);
const nick = z.string().trim().min(1).max(24);

export const ClientMsg = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('join'),
    nick,
    sessionId: z.string().min(8).max(64),
    create: z.boolean().optional(),
    hostToken: z.string().max(64).optional(),
    password: z.string().max(64).optional(),
  }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(LIMITS.chatLen) }),
  z.object({ t: z.literal('typing') }),
  z.object({ t: z.literal('reaction'), emoji: z.enum(REACTIONS) }),

  // playback (host / mod)
  z.object({ t: z.literal('load'), url: z.string().max(2000), title: z.string().trim().max(200).optional() }),
  z.object({
    t: z.literal('control'),
    action: z.enum(['play', 'pause', 'seek']),
    position,
  }),
  z.object({ t: z.literal('ended'), position: position.optional() }),

  // queue
  z.object({ t: z.literal('queueAdd'), url: z.string().max(2000), title: z.string().trim().max(200).optional() }),
  // a whole playlist (or several picks) at once: one queue update for everyone instead of one per video
  z.object({
    t: z.literal('queueAddMany'),
    items: z.array(z.object({ url: z.string().max(2000), title: z.string().trim().max(200).optional() })).min(1).max(200),
  }),
  z.object({ t: z.literal('queueRemove'), id: z.string().max(64) }),
  z.object({ t: z.literal('queueVote'), id: z.string().max(64) }),
  z.object({ t: z.literal('queuePlay'), id: z.string().max(64) }),
  z.object({ t: z.literal('queueApprove'), id: z.string().max(64) }),
  z.object({ t: z.literal('queueNext') }),
  z.object({ t: z.literal('queuePrev') }),
  z.object({ t: z.literal('queueClear') }),
  z.object({ t: z.literal('historyPlay'), id: z.string().max(64) }),
  z.object({ t: z.literal('queueShuffle') }),

  // moderation
  z.object({ t: z.literal('setRole'), id: z.string().max(64), role: z.enum(['mod', 'viewer']) }),
  z.object({ t: z.literal('kick'), id: z.string().max(64) }),
  // the host ends the room: everyone is removed and the room's files and chat are deleted at once
  z.object({ t: z.literal('closeRoom') }),
  z.object({ t: z.literal('mute'), id: z.string().max(64), muted: z.boolean() }),
  z.object({
    t: z.literal('roomSettings'),
    locked: z.boolean().optional(),
    password: z.string().max(64).nullable().optional(),
    /** what happens when a video ends and nothing is queued: stop, replay the queue, or replay this video */
    repeat: z.enum(['off', 'all', 'one']).optional(),
  }),
  z.object({ t: z.literal('report'), id: z.string().max(64), reason: z.string().max(120) }),

  // host-stream
  z.object({
    t: z.literal('streamStart'),
    fileName: z.string().max(200),
    fileSize: z.number().finite().min(0),
    source: z.enum(['file', 'screen']),
    position,
  }),
  z.object({ t: z.literal('streamStop') }),
  z.object({ t: z.literal('streamPosition'), position }),

  // webrtc signalling relay (stream + voice)
  z.object({ t: z.literal('signal'), to: z.string().max(64), data: z.unknown() }),
  z.object({ t: z.literal('voice'), on: z.boolean() }),
  // voice and camera, encoded in the browser and relayed by the server to the other people in voice
  z.object({
    t: z.literal('media'),
    kind: z.enum(['audio', 'video', 'cam', 'mic', 'keyreq']),
    ts: z.number().int().min(0).max(1e15),
    key: z.boolean().optional(),
    on: z.boolean().optional(),
    rate: z.number().int().min(8000).max(96000).optional(),
    ch: z.number().int().min(1).max(2).optional(),
    data: z.string().max(LIMITS.mediaChunk).optional(),
    /** 'keyreq' only: who should send a key frame */
    to: z.string().max(64).optional(),
    /** video only: counts up by one per chunk, so a receiver can tell when one went missing */
    seq: z.number().int().min(0).max(1e12).optional(),
  }),

  // polls
  z.object({
    t: z.literal('pollCreate'),
    question: z.string().trim().min(1).max(120),
    options: z.array(z.string().trim().min(1).max(60)).min(2).max(4),
  }),
  z.object({ t: z.literal('pollVote'), index: z.number().int().min(0).max(3) }),
  z.object({ t: z.literal('pollClose') }),
]);

export type ClientMsg = z.infer<typeof ClientMsg>;
