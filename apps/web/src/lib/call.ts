import { create } from 'zustand';

/** What the video tiles show: whether we are in voice, our own camera, and each member's camera track. */
interface CallState {
  inVoice: boolean;
  camera: MediaStreamTrack | null;
  remote: Record<string, MediaStreamTrack>;
  /** Whether each remote member says their camera is on (the track alone does not tell us). */
  remoteCam: Record<string, boolean>;
  /** Members who turned their own microphone off (their tile shows the muted badge). */
  micOff: Record<string, boolean>;
  /** Who is talking right now, us included (their tile is outlined). */
  speaking: Record<string, boolean>;
  setInVoice(on: boolean): void;
  setCamera(track: MediaStreamTrack | null): void;
  setRemote(id: string, track: MediaStreamTrack | null): void;
  setRemoteCam(id: string, on: boolean): void;
  setMicOff(id: string, off: boolean): void;
  setSpeaking(id: string, on: boolean): void;
  reset(): void;
}

/** A copy of `map` with `id` set (true) or removed (false); the same object when nothing changes, so nothing re-renders. */
function flag(map: Record<string, boolean>, id: string, on: boolean): Record<string, boolean> {
  if (!!map[id] === on) return map;
  const next = { ...map };
  if (on) next[id] = true;
  else delete next[id];
  return next;
}

export const useCall = create<CallState>((set) => ({
  inVoice: false,
  camera: null,
  remote: {},
  remoteCam: {},
  micOff: {},
  speaking: {},
  setInVoice: (inVoice) => set({ inVoice }),
  setCamera: (camera) => set({ camera }),
  setRemote: (id, track) =>
    set((s) => {
      const remote = { ...s.remote };
      if (track) remote[id] = track;
      else delete remote[id];
      return { remote };
    }),
  setRemoteCam: (id, on) => set((s) => ({ remoteCam: flag(s.remoteCam, id, on) })),
  setMicOff: (id, off) => set((s) => ({ micOff: flag(s.micOff, id, off) })),
  setSpeaking: (id, on) => set((s) => ({ speaking: flag(s.speaking, id, on) })),
  reset: () => set({ inVoice: false, camera: null, remote: {}, remoteCam: {}, micOff: {}, speaking: {} }),
}));
