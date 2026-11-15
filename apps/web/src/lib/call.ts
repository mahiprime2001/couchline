import { create } from 'zustand';

/** What the video tiles show: whether we are in voice, our own camera, and each member's camera track. */
interface CallState {
  inVoice: boolean;
  camera: MediaStreamTrack | null;
  remote: Record<string, MediaStreamTrack>;
  /** Whether each remote member says their camera is on (the track alone does not tell us). */
  remoteCam: Record<string, boolean>;
  setInVoice(on: boolean): void;
  setCamera(track: MediaStreamTrack | null): void;
  setRemote(id: string, track: MediaStreamTrack | null): void;
  setRemoteCam(id: string, on: boolean): void;
  reset(): void;
}

export const useCall = create<CallState>((set) => ({
  inVoice: false,
  camera: null,
  remote: {},
  remoteCam: {},
  setInVoice: (inVoice) => set({ inVoice }),
  setCamera: (camera) => set({ camera }),
  setRemote: (id, track) =>
    set((s) => {
      const remote = { ...s.remote };
      if (track) remote[id] = track;
      else delete remote[id];
      return { remote };
    }),
  setRemoteCam: (id, on) =>
    set((s) => {
      const remoteCam = { ...s.remoteCam };
      if (on) remoteCam[id] = true;
      else delete remoteCam[id];
      return { remoteCam };
    }),
  reset: () => set({ inVoice: false, camera: null, remote: {}, remoteCam: {} }),
}));
