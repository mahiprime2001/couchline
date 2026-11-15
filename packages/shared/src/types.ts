export type Role = 'host' | 'mod' | 'viewer';
export type RoomMode = 'idle' | 'link' | 'stream';
/**
 * youtube: embedded player. file: a direct video file. hls: a chunked stream (.m3u8), e.g. a video the server converted.
 * site: any other page (Vimeo, Twitch, SoundCloud, …); only playable through a yt-dlp copy.
 */
export type LinkKind = 'youtube' | 'file' | 'hls' | 'site';
export type StreamSource = 'file' | 'screen';

export interface Member {
  id: string;
  nick: string;
  role: Role;
  muted: boolean;
  voice: boolean;
}

export interface SyncState {
  mode: RoomMode;
  url: string;
  kind: LinkKind | null;
  videoId: string | null;
  playing: boolean;
  /** seconds, valid at `updatedAt` (server clock, ms) */
  position: number;
  updatedAt: number;
  /** the video's title, when whoever started it knew it (queue, search, playlist) */
  title?: string;
}

export interface StreamInfo {
  /** host is connected and currently sending the stream */
  live: boolean;
  fileName: string;
  fileSize: number;
  /** last known position of the host's file, used to resume */
  lastPosition: number;
  source: StreamSource;
  epoch: number;
}

export interface QueueItem {
  id: string;
  url: string;
  kind: LinkKind;
  videoId: string | null;
  /** the video's title when the adder knew it (search results, playlists, suggestions) */
  title?: string;
  by: string;
  byId: string;
  votes: string[];
  /** viewer suggestions wait for the host/mods; only approved items auto-play */
  approved: boolean;
}

export interface Poll {
  id: string;
  question: string;
  options: string[];
  /** memberId -> option index */
  votes: Record<string, number>;
  open: boolean;
}

export interface ChatMsg {
  id: string;
  fromId: string;
  nick: string;
  text: string;
  at: number;
  system?: boolean;
}

export interface RoomSnapshot {
  code: string;
  members: Member[];
  sync: SyncState;
  stream: StreamInfo;
  queue: QueueItem[];
  /** what already played, oldest first (for "previous" and "play again") */
  history: QueueItem[];
  poll: Poll | null;
  locked: boolean;
  hasPassword: boolean;
  repeat: RepeatMode;
  chat: ChatMsg[];
}

export type RoomPhase = 'LINK_ACTIVE' | 'STREAM_LIVE' | 'STREAM_HOST_AWAY';
export type RepeatMode = 'off' | 'all' | 'one';

export type ServerMsg =
  | { t: 'welcome'; you: Member; hostToken?: string; serverTime: number; room: RoomSnapshot }
  | { t: 'members'; members: Member[] }
  | { t: 'sync'; sync: SyncState }
  | { t: 'stream'; stream: StreamInfo }
  | { t: 'queue'; queue: QueueItem[]; history: QueueItem[] }
  | { t: 'poll'; poll: Poll | null }
  | { t: 'chat'; msg: ChatMsg }
  | { t: 'typing'; id: string; nick: string }
  | { t: 'reaction'; id: string; nick: string; emoji: string }
  | { t: 'signal'; from: string; data: unknown }
  | {
      t: 'media';
      from: string;
      kind: 'audio' | 'video' | 'cam' | 'keyreq';
      ts: number;
      key?: boolean;
      on?: boolean;
      rate?: number;
      ch?: number;
      data?: string;
    }
  | { t: 'room'; locked: boolean; hasPassword: boolean; repeat: RepeatMode }
  | { t: 'kicked'; reason: string }
  | { t: 'error'; code: string; message: string };
