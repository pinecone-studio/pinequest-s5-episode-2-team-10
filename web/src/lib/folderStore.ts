export interface FolderMeta {
  id: string;
  name: string;
  slideName: string | null;
  audioName: string | null;
  /** The pitch idea and main points the speech should get across (optional, added later). */
  idea?: string;
  keyPoints?: string[];
  /** Figma Slides (or prototype) share link, played live with its animations (optional). */
  figmaUrl?: string | null;
}

const LEGACY_KEY = "pitchcoach:folders";
let userId: string | null = null;

/** Which account's folder list to read. Set before the desk loads. */
export function setFolderUser(id: string | null) {
  userId = id;
}

function listKey(): string | null {
  return userId ? `${LEGACY_KEY}:${userId}` : null;
}
const DB_NAME = "pitchcoach-folders";
const STORE = "blobs";

export const FIGMA_FOLDER: FolderMeta = {
  id: "figma-tdd",
  name: "figma tdd",
  slideName: null,
  audioName: null,
};

function parseList(raw: string | null): FolderMeta[] | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as FolderMeta[];
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  return parsed;
}

export function loadFolders(): FolderMeta[] {
  const key = listKey();
  if (!key) return [FIGMA_FOLDER];
  try {
    const own = parseList(localStorage.getItem(key));
    if (own) return own;
    // First sign-in on this browser keeps the folders saved before accounts existed.
    if (localStorage.getItem(key) === null) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(LEGACY_KEY);
        const copied = parseList(legacy);
        if (copied) return copied;
      }
    }
  } catch {
    return [FIGMA_FOLDER];
  }
  return [FIGMA_FOLDER];
}

export function saveFolders(folders: FolderMeta[]) {
  const key = listKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(folders));
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putFolderBlob(key: string, blob: Blob) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getFolderBlob(key: string): Promise<Blob | null> {
  const db = await openDb();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return blob;
}

export const slideKey = (id: string) => `${id}:slide`;
export const audioKey = (id: string) => `${id}:audio`;
const speechKey = (id: string) => `pitchcoach:speech:${id}`;

export function loadSpeech(id: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(speechKey(id)) ?? "";
  } catch {
    return "";
  }
}

export function saveSpeech(id: string, text: string) {
  if (typeof window === "undefined") return;
  try {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) localStorage.removeItem(speechKey(id));
    else localStorage.setItem(speechKey(id), trimmed);
  } catch {
    /* private mode or a full quota */
  }
}
