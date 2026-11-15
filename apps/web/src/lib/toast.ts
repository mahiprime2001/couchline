import { create } from 'zustand';

/** A short pop-up (a link that will not play, a failed download, …) that goes away by itself after 5 seconds. */
export const useToast = create<{ toast: { id: number; text: string } | null; show(text: string): void; hide(): void }>((set) => ({
  toast: null,
  show: (text) => set({ toast: { id: Date.now(), text } }),
  hide: () => set({ toast: null }),
}));
