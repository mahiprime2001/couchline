import { z } from 'zod';

export const REACTIONS = ['❤️', '😂', '😮', '👏', '🔥', '😢'] as const;

export const LIMITS = {
  maxMembers: 50,
  maxViewersStream: 8,
  maxVoice: 6,
  chatHistory: 50,
  chatLen: 300,
  queueMax: 200, // room for a whole YouTube playlist
  graceLinkMs: 5 * 60_000,
  graceStreamMs: 20 * 60_000,
} as const;

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
  z.object({ t: z.literal('load'), url: z.string().max(500), title: z.string().trim().max(200).optional() }),
  z.object({
    t: z.literal('control'),
    action: z.enum(['play', 'pause', 'seek']),
    position,
  }),
  z.object({ t: z.literal('ended'), position: position.optional() }),

  // queue
  z.object({ t: z.literal('queueAdd'), url: z.string().max(500), title: z.string().trim().max(200).optional() }),
  // a whole playlist (or several picks) at once: one queue update for everyone instead of one per video
  z.object({
    t: z.literal('queueAddMany'),
    items: z.array(z.object({ url: z.string().max(500), title: z.string().trim().max(200).optional() })).min(1).max(200),
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
