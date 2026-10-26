import { SHARED_BLOBS, SHARED_FOLDER, SHARED_SPEECH } from "./defaultFolder";
import { DEMO_BLOBS, DEMO_FOLDERS, DEMO_SPEECHES } from "./demoPitches";
import { attachAudio, attachSlide, normalizeFolder, selectedAudio, type FolderAudio, type FolderSlide } from "./folderFiles";
import { USING_MOCK } from "./api";
import {
  createServerFolder,
  deleteServerAudio,
  deleteServerFolder,
  fetchServerBlob,
  listServerFolders,
  migrateLocalFolders,
  updateServerFolder,
  uploadServerAudio,
  uploadServerSlide,
  type ServerFolder,
} from "./folderPersistence";

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
  script?: string;
  currentSessionId?: string | null;
}

const LEGACY_KEY = "pitchcoach:folders";
let userId: string | null = null;
let localDemoAccount = false;
let remoteMode = false;
let storeReady = false;
let storeError: string | null = null;
let hydration: Promise<void> = Promise.resolve();

/** Which account's folder list to read. Set before the desk loads. */
export function setFolderUser(id: string | null, isDemoAccount = false) {
  if (id === userId && isDemoAccount === localDemoAccount) return;
  userId = id;
  localDemoAccount = isDemoAccount;
  remoteMode = Boolean(id && !USING_MOCK && !isDemoAccount);
  snapshot = null;
  storeReady = false;
  storeError = null;
  if (remoteMode) {
    snapshot = [];
    hydration = hydrateRemoteFolders(id!);
  } else {
    snapshot = id ? loadFolders() : null;
    storeReady = true;
    hydration = Promise.resolve();
  }
  // Called while rendering (AuthGate), so tell listeners afterwards.
  queueMicrotask(notify);
}

export function waitForFolderStore(): Promise<void> {
  return hydration;
}

export function folderStoreError(): string | null {
  return storeError;
}

export function retryFolderStore() {
  if (remoteMode && userId) hydration = hydrateRemoteFolders(userId);
  return hydration;
}

async function hydrateRemoteFolders(accountId: string) {
  try {
    const migratedKey = `pitchcoach:remote-migrated:${accountId}`;
    if (localStorage.getItem(migratedKey) !== "1") {
      const localFolders = loadFolders().map((folder) => ({
        ...normalizeFolder(folder),
        script: readLocalSpeech(folder.id),
        currentSessionId: null,
      })) as ServerFolder[];
      if (localFolders.length) {
        await migrateLocalFolders(localFolders, readLocalFolderBlob, removeMigratedLocalData);
      }
      localStorage.setItem(migratedKey, "1");
    }
    snapshot = await listServerFolders();
    storeReady = true;
    storeError = null;
  } catch (error) {
    snapshot = [];
    storeReady = false;
    storeError = error instanceof Error ? error.message : "Could not sync folders with the backend.";
  }
  notify();
}

// The folder list for other parts of the page (the sidebar), kept in step with saveFolders.
const NO_FOLDERS: FolderMeta[] = [];
let snapshot: FolderMeta[] | null = null;
const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

/** For useSyncExternalStore: call `listener` whenever the folder list changes. */
export function subscribeFolders(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current account's folders; the same array until the list changes. */
export function folderSnapshot(): FolderMeta[] {
  if (!userId) return NO_FOLDERS;
  if (remoteMode) return snapshot ?? NO_FOLDERS;
  snapshot ??= loadFolders();
  return snapshot;
}

export function folderStoreIsReady(): boolean {
  return storeReady;
}

/** Server render: no folders (they live in the browser). */
export function serverFolderSnapshot(): FolderMeta[] {
  return NO_FOLDERS;
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

const DEMO_FLAG = "pitchcoach:demo-pitches:v1";

/** Adds `seeds` once per account (flag `flagKey`), at the end of the list. Deleted ones stay gone. */
function withSeeds(folders: FolderMeta[], seeds: FolderMeta[], flagKey: string, atStart = false): FolderMeta[] {
  const flag = userId ? `${flagKey}:${userId}` : null;
  if (flag && localStorage.getItem(flag) === "1") return folders;
  const missing = seeds.filter((seed) => !folders.some((folder) => folder.id === seed.id)).map(normalizeFolder);
  const next = atStart ? [...missing, ...folders] : [...folders, ...missing];
  const key = listKey();
  if (key && missing.length) localStorage.setItem(key, JSON.stringify(next));
  if (flag) localStorage.setItem(flag, "1");
  return next;
}

/** The shared folder's first name; saved copies that still have it take the current one. */
const SHARED_OLD_NAME = "ok";

/** Adds the shared "Coach" folder and the demo pitches once per account. Deleting them keeps them gone. */
function withSharedFolder(folders: FolderMeta[]): FolderMeta[] {
  let renamed = false;
  const current = folders.map((folder) => {
    if (folder.id !== SHARED_FOLDER.id || folder.name !== SHARED_OLD_NAME) return normalizeFolder(folder);
    renamed = true;
    return normalizeFolder({ ...folder, name: SHARED_FOLDER.name });
  });
  if (renamed) {
    const key = listKey();
    if (key) localStorage.setItem(key, JSON.stringify(current));
  }
  const withCoach = withSeeds(current, [SHARED_FOLDER], SHARED_FLAG, true);
  return withSeeds(withCoach, DEMO_FOLDERS, DEMO_FLAG);
}

export function loadFolders(): FolderMeta[] {
  const key = listKey();
  if (!key) return [SHARED_FOLDER, ...DEMO_FOLDERS].map(normalizeFolder);
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
  if (remoteMode) {
    snapshot = folders;
    notify();
    const changed = folders as ServerFolder[];
    for (const folder of changed) {
      const timer = saveTimers.get(folder.id);
      if (timer) window.clearTimeout(timer);
      saveTimers.set(folder.id, window.setTimeout(() => {
        saveTimers.delete(folder.id);
        void updateServerFolder(folder).then((updated) => {
          snapshot = (snapshot ?? []).map((item) => item.id === updated.id ? updated : item);
          notify();
        }).catch((error: unknown) => {
          storeError = error instanceof Error ? error.message : "Could not save this folder to the backend.";
          notify();
        });
      }, 400));
    }
    return;
  }
  const key = listKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(folders));
  snapshot = folders;
  notify();
}

const saveTimers = new Map<string, number>();

export function usesRemoteFolderStore() {
  return remoteMode;
}

export async function createFolderRecord(folder: Omit<FolderMeta, "id">): Promise<FolderMeta> {
  if (remoteMode) {
    return createServerFolder({ ...folder, script: folder.script ?? "" });
  }
  return normalizeFolder({ ...folder, id: crypto.randomUUID() });
}

export async function saveFolderSlide(folder: FolderMeta, file: File): Promise<FolderMeta> {
  if (remoteMode) return uploadServerSlide(folder as ServerFolder, file, file.name);
  const updated = attachSlide(folder, { name: file.name, type: file.type }, new Date().toISOString());
  await putFolderBlob(updated.slide?.storageKey ?? slideKey(folder.id), file);
  return updated;
}

export async function saveFolderAudio(
  folder: FolderMeta,
  file: Blob,
  name: string,
  type: string,
  durationS: number | null,
): Promise<FolderMeta> {
  if (remoteMode) return uploadServerAudio(folder as ServerFolder, file, name);
  const updated = attachAudio(folder, { name, type, durationS }, crypto.randomUUID(), new Date().toISOString());
  const record = selectedAudio(updated);
  if (record) await putFolderBlob(record.storageKey, file);
  return updated;
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

async function readIndexedBlob(key: string): Promise<Blob | null> {
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

async function readLocalFolderBlob(key: string): Promise<Blob | null> {
  const local = await readIndexedBlob(key);
  if (local) return local;
  const shared = SHARED_BLOBS[key] ?? DEMO_BLOBS[key];
  if (!shared) return null;
  try {
    const response = await fetch(shared.url);
    if (!response.ok) return null;
    return new Blob([await response.arrayBuffer()], { type: shared.type });
  } catch {
    return null;
  }
}

async function removeLocalBlob(key: string) {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function removeMigratedLocalData(folders: ServerFolder[]) {
  const key = listKey();
  if (key) localStorage.removeItem(key);
  localStorage.removeItem(LEGACY_KEY);
  for (const folder of folders) {
    localStorage.removeItem(speechKey(folder.id));
    localStorage.removeItem(`pitchcoach:backend-project:${folder.id}`);
    localStorage.removeItem(`pitchcoach:remote-slide:${folder.id}`);
    for (const audio of folder.audios ?? []) {
      localStorage.removeItem(`pitchcoach:remote-audio:${folder.id}:${audio.id}`);
      await removeLocalBlob(audio.storageKey);
    }
    if (folder.slide) await removeLocalBlob(folder.slide.storageKey);
    await removeLocalBlob(slideKey(folder.id));
    await removeLocalBlob(audioKey(folder.id));
  }
}

export async function putFolderBlob(key: string, blob: Blob) {
  if (remoteMode) throw new Error("Member folder files must be uploaded through the backend.");
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
  if (remoteMode) {
    if (!key.startsWith("api-")) return null;
    try { return await fetchServerBlob(key); } catch { return null; }
  }
  const db = await openDb();
  const blob = await new Promise<Blob | null>((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as Blob | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (blob) return blob;
  const shared = SHARED_BLOBS[key] ?? DEMO_BLOBS[key];
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

/** Where the word timings of a stored recording are kept (see coachVoice.ts). */
export const timingsKey = (storageKey: string) => `pitchcoach:timings:${storageKey}`;

/** Deletes a stored file, and the word timings saved for it when it is a recording. */
export async function deleteFolderBlob(key: string) {
  try {
    localStorage.removeItem(timingsKey(key));
  } catch {
    /* storage blocked: nothing saved to remove */
  }
  if (remoteMode && key.startsWith("api-audio:")) {
    await deleteServerAudio(key.slice("api-audio:".length));
    return;
  }
  if (remoteMode) return;
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

/** Renames a folder in the saved list (the sidebar and the folder page both follow it). */
export function renameFolder(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  saveFolders(folderSnapshot().map((f) => (f.id === id ? { ...f, name: trimmed } : f)));
}

/** Removes a folder from the saved list, then its files and speech text. */
export async function removeFolder(folder: FolderMeta) {
  if (remoteMode) {
    await deleteServerFolder(folder.id);
    snapshot = (snapshot ?? []).filter((item) => item.id !== folder.id);
    notify();
    return;
  }
  saveFolders(folderSnapshot().filter((f) => f.id !== folder.id));
  await deleteFolderData(folder);
}

/** Removes a folder's files and saved speech text from this browser. The list is saved separately. */
export async function deleteFolderData(folder: FolderMeta) {
  if (remoteMode) return;
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
  if (remoteMode) return snapshot?.find((folder) => folder.id === id)?.script ?? "";
  return readLocalSpeech(id);
}

function readLocalSpeech(id: string): string {
  try {
    return localStorage.getItem(speechKey(id)) ?? (id === SHARED_FOLDER.id ? SHARED_SPEECH : DEMO_SPEECHES[id] ?? "");
  } catch {
    return "";
  }
}

export function saveSpeech(id: string, text: string) {
  if (typeof window === "undefined") return;
  if (remoteMode) {
    const folders = snapshot ?? [];
    if (folders.some((folder) => folder.id === id)) {
      saveFolders(folders.map((folder) => folder.id === id ? { ...folder, script: text.replace(/\s+/g, " ").trim() } : folder));
    }
    return;
  }
  try {
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (!trimmed) localStorage.removeItem(speechKey(id));
    else localStorage.setItem(speechKey(id), trimmed);
  } catch {
    /* private mode or a full quota */
  }
}
