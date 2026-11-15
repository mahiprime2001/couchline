/* eslint-disable @typescript-eslint/no-explicit-any */
// Remembers the host's chosen file (File System Access API handle) in IndexedDB so
// the host can resume a stream after reconnecting without hunting for the file.
// The handle only lives in the host's own browser. Nothing is sent to a server.

const DB = 'wp-handles';
const STORE = 'h';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveHandle(code: string, handle: unknown): Promise<void> {
  try {
    const d = await db();
    await new Promise<void>((res, rej) => {
      const tx = d.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(handle, code);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  } catch {
    /* storage unavailable: resume will just ask for the file again */
  }
}

export async function loadHandle(code: string): Promise<any | null> {
  try {
    const d = await db();
    return await new Promise((res) => {
      const req = d.transaction(STORE).objectStore(STORE).get(code);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror = () => res(null);
    });
  } catch {
    return null;
  }
}

export const hasFilePicker = (): boolean => typeof (window as any).showOpenFilePicker === 'function';

/** Returns a File (and its handle when the browser supports handles). */
export async function pickVideoFile(): Promise<{ file: File; handle: any | null } | null> {
  const w = window as any;
  if (hasFilePicker()) {
    try {
      const [handle] = await w.showOpenFilePicker({
        multiple: false,
        types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.webm', '.mkv', '.mov', '.m4v', '.ogv'] } }],
      });
      return { file: await handle.getFile(), handle };
    } catch {
      return null; // cancelled
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      resolve(file ? { file, handle: null } : null);
    };
    input.click();
  });
}

/** Re-open a remembered file. Needs a user gesture because the browser re-asks for permission. */
export async function reopenHandle(handle: any): Promise<File | null> {
  try {
    if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') return null;
    }
    return await handle.getFile();
  } catch {
    return null;
  }
}
