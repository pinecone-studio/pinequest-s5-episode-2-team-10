// One folder holds one slide and every audio take for that slide. These records
// keep names, keys, and dates; signed-in member files live in backend storage.

export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".webm", ".ogg"]);
const AUDIO_TYPES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/webm",
  "audio/ogg",
]);

const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  webm: "audio/webm",
  ogg: "audio/ogg",
};

export interface FolderSlide {
  id: string;
  folderId: string;
  title: string;
  filename: string;
  storageKey: string;
  fileType: string;
  createdAt: string;
}

export interface FolderAudio {
  id: string;
  folderId: string;
  filename: string;
  storageKey: string;
  fileType: string;
  durationS: number | null;
  createdAt: string;
}

export interface FolderRecord {
  id: string;
  name: string;
  slideName: string | null;
  audioName: string | null;
  audioId?: string | null;
  slide?: FolderSlide | null;
  audios?: FolderAudio[];
  idea?: string;
  keyPoints?: string[];
  /** Each main point's slide number (as on screen), in the same order; null = no slide. */
  pointSlides?: (number | null)[];
  figmaUrl?: string | null;
}

export const slideStorageKey = (folderId: string) => `${folderId}:slide`;
export const legacyAudioKey = (folderId: string) => `${folderId}:audio`;
export const audioStorageKey = (folderId: string, audioId: string) => `${folderId}:audio:${audioId}`;

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export function typeFromName(name: string): string {
  return TYPES[extension(name).slice(1)] ?? "";
}

/** "type" or "size" when the file cannot be stored. Same limits as the API audio upload. */
export function audioFileError(file: { name: string; type: string; size: number }): "type" | "size" | null {
  if (file.size > AUDIO_MAX_BYTES) return "size";
  const type = file.type.split(";")[0].trim().toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension(file.name)) && !AUDIO_TYPES.has(type)) return "type";
  return null;
}

function legacySlide(folder: FolderRecord): FolderSlide | null {
  if (!folder.slideName) return null;
  return {
    id: `${folder.id}:slide`,
    folderId: folder.id,
    title: folder.slideName,
    filename: folder.slideName,
    storageKey: slideStorageKey(folder.id),
    fileType: typeFromName(folder.slideName),
    createdAt: "",
  };
}

function legacyAudio(folder: FolderRecord): FolderAudio | null {
  if (!folder.audioName) return null;
  return {
    id: `${folder.id}:audio`,
    folderId: folder.id,
    filename: folder.audioName,
    storageKey: legacyAudioKey(folder.id),
    fileType: typeFromName(folder.audioName),
    durationS: null,
    createdAt: "",
  };
}

/** Fills slide and audio records for folders saved before they were stored separately. */
export function normalizeFolder<T extends FolderRecord>(folder: T): T {
  const slide = folder.slide ?? legacySlide(folder);
  const audios = folder.audios && folder.audios.length > 0 ? folder.audios : legacyAudio(folder) ? [legacyAudio(folder)!] : [];
  const audioId = audios.some((audio) => audio.id === folder.audioId) ? folder.audioId ?? null : (audios.at(-1)?.id ?? null);
  const selected = audios.find((audio) => audio.id === audioId) ?? null;
  return {
    ...folder,
    slide,
    audios,
    audioId,
    slideName: slide?.filename ?? null,
    audioName: selected?.filename ?? null,
  };
}

export function selectedAudio(folder: FolderRecord): FolderAudio | null {
  const current = normalizeFolder(folder);
  return (current.audios ?? []).find((audio) => audio.id === current.audioId) ?? null;
}

/** One slide per folder. Replacing the file keeps the same slide id and storage key. */
export function attachSlide<T extends FolderRecord>(folder: T, file: { name: string; type: string }, createdAt: string): T {
  const current = normalizeFolder(folder);
  const slide: FolderSlide = {
    id: current.slide?.id ?? `${folder.id}:slide`,
    folderId: folder.id,
    title: file.name,
    filename: file.name,
    storageKey: slideStorageKey(folder.id),
    fileType: file.type.split(";")[0].trim() || typeFromName(file.name),
    createdAt,
  };
  return { ...current, slide, slideName: slide.filename };
}

/** Adds an audio take. A second save of the same id updates that row instead of duplicating it. */
export function attachAudio<T extends FolderRecord>(
  folder: T,
  file: { name: string; type: string; durationS: number | null },
  id: string,
  createdAt: string,
): T {
  const current = normalizeFolder(folder);
  const storageKey = id.endsWith(":audio") ? legacyAudioKey(folder.id) : audioStorageKey(folder.id, id);
  const record: FolderAudio = {
    id,
    folderId: folder.id,
    filename: file.name,
    storageKey,
    fileType: file.type.split(";")[0].trim() || typeFromName(file.name),
    durationS: file.durationS,
    createdAt,
  };
  const audios = current.audios ?? [];
  const at = audios.findIndex((audio) => audio.id === id || audio.storageKey === storageKey);
  const next = at >= 0 ? audios.map((audio, index) => (index === at ? record : audio)) : [...audios, record];
  return { ...current, audios: next, audioId: record.id, audioName: record.filename };
}

export function selectAudio<T extends FolderRecord>(folder: T, audioId: string): T {
  const current = normalizeFolder(folder);
  const record = (current.audios ?? []).find((audio) => audio.id === audioId);
  if (!record) return current;
  return { ...current, audioId: record.id, audioName: record.filename };
}

/** Drops one audio. The storage key comes back only when no other row still uses it. */
export function detachAudio<T extends FolderRecord>(folder: T, audioId: string): { folder: T; storageKey: string | null } {
  const current = normalizeFolder(folder);
  const audios = current.audios ?? [];
  const target = audios.find((audio) => audio.id === audioId);
  if (!target) return { folder: current, storageKey: null };
  const next = audios.filter((audio) => audio.id !== audioId);
  const stillUsed = next.some((audio) => audio.storageKey === target.storageKey);
  const audioIdNext = current.audioId === audioId ? (next.at(-1)?.id ?? null) : (current.audioId ?? null);
  const selected = next.find((audio) => audio.id === audioIdNext) ?? null;
  return {
    folder: { ...current, audios: next, audioId: audioIdNext, audioName: selected?.filename ?? null },
    storageKey: stillUsed ? null : target.storageKey,
  };
}
