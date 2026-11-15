import { create } from 'zustand';

/**
 * A file the browser could not stream (its video or sound format is not supported here). The host can then
 * convert it on the server ("Convert on the server"), which works for any format ffmpeg reads and plays on every
 * device. `convert` counts up each time the host asks, so the upload panel knows to start.
 */
interface HostedFallback {
  file: File | null;
  reason: string | null;
  convert: number;
  offer(file: File, reason: string): void;
  clear(): void;
  requestConvert(): void;
}

export const useHostedFallback = create<HostedFallback>((set, get) => ({
  file: null,
  reason: null,
  convert: 0,
  offer: (file, reason) => set({ file, reason }),
  clear: () => set({ file: null, reason: null }),
  requestConvert: () => set({ convert: get().convert + 1 }),
}));
