import { SHARED_BLOBS, SHARED_FOLDER, SHARED_SPEECH } from "./defaultFolder";
import { normalizeFolder, type FolderAudio, type FolderSlide } from "./folderFiles";

export type { FolderAudio, FolderSlide };
export {
  attachAudio,
  attachSlide,
  audioFileError,
  audioStorageKey,
  detachAudio,
  legacyAudioKey,
  selectAudio,
  selectedAudio,
  slideStorageKey,
} from "./folderFiles";

export interface FolderMeta {
  id: string;
  name: string;
  slideName: string | null;
  audioName: string | null;
  /** The audio the player and analysis use. */
  audioId?: string | null;
  /** The one slide in this folder. */
  slide?: FolderSlide | null;
  /** Every audio take for that slide, oldest first. */
  audios?: FolderAudio[];
  /** The pitch idea and main points the speech should get across (optional, added later). */
  idea?: string;
  keyPoints?: string[];
  /** Each main point's slide number (as on screen), in the same order; null = no slide. */
  pointSlides?: (number | null)[];
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

/** The saved list, or null when there is none. An empty list is kept: every folder was deleted. */
function parseList(raw: string | null): FolderMeta[] | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as FolderMeta[];
  return Array.isArray(parsed) ? parsed : null;
}

const SHARED_FLAG = "pitchcoach:shared-ok";

/** Adds the shared "ok" folder once per account. Deleting it afterwards keeps it gone. */
function withSharedFolder(folders: FolderMeta[]): FolderMeta[] {
  const normalized = folders.map(normalizeFolder);
  const flag = userId ? `${SHARED_FLAG}:${userId}` : null;
  if (normalized.some((folder) => folder.id === SHARED_FOLDER.id)) {
    if (flag) localStorage.setItem(flag, "1");
    return normalized;
  }
  if (flag && localStorage.getItem(flag) === "1") return normalized;
  const next = [normalizeFolder(SHARED_FOLDER), ...normalized];
  const key = listKey();
  if (key) localStorage.setItem(key, JSON.stringify(next));
  if (flag) localStorage.setItem(flag, "1");
  return next;
}

export function loadFolders(): FolderMeta[] {
  const key = listKey();
  if (!key) return [normalizeFolder(SHARED_FOLDER)];
  try {
    const own = parseList(localStorage.getItem(key));
    if (own) return withSharedFolder(own);
    // First sign-in on this browser keeps the folders saved before accounts existed.
    if (localStorage.getItem(key) === null) {
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        localStorage.setItem(key, legacy);
        localStorage.removeItem(LEGACY_KEY);
        const copied = parseList(legacy);
        if (copied) return withSharedFolder(copied);
      }
    }
  } catch {
    return withSharedFolder([FIGMA_FOLDER]);
  }
  return withSharedFolder([FIGMA_FOLDER]);
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
  if (blob) return blob;
  const shared = SHARED_BLOBS[key];
  if (!shared) return null;
  try {
    const res = await fetch(shared.url);
    if (!res.ok) return null;
    const fetched = new Blob([await res.arrayBuffer()], { type: shared.type });
    await putFolderBlob(key, fetched);
    return fetched;
  } catch {
    return null;
  }
}

export async function deleteFolderBlob(key: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export const slideKey = (id: string) => `${id}:slide`;
export const audioKey = (id: string) => `${id}:audio`;
const speechKey = (id: string) => `pitchcoach:speech:${id}`;

/** Removes a folder's files and saved speech text from this browser. The list is saved separately. */
export async function deleteFolderData(folder: FolderMeta) {
  const keys = new Set([slideKey(folder.id), audioKey(folder.id), ...(folder.audios ?? []).map((a) => a.storageKey)]);
  await Promise.all([...keys].map((key) => deleteFolderBlob(key).catch(() => undefined)));
  try {
    localStorage.removeItem(speechKey(folder.id));
  } catch {
    /* storage blocked: nothing saved to remove */
  }
}

export function loadSpeech(id: string): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(speechKey(id)) ?? (id === SHARED_FOLDER.id ? SHARED_SPEECH : "");
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
