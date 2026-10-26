import { api, ApiRequestError } from "./api";
import { normalizeFolder, type FolderAudio, type FolderRecord, type FolderSlide } from "./folderFiles";
import type { Project, ProjectDetails } from "./types";

export type ServerFolder = FolderRecord & { script: string; currentSessionId: string | null };
type ProjectFolderData = Pick<ServerFolder, "name" | "idea" | "keyPoints" | "pointSlides" | "figmaUrl" | "script" | "audioId"> & { id?: string };

const audioKey = (sessionId: string) => `api-audio:${sessionId}`;
const slideKey = (sessionId: string) => `api-slide:${sessionId}`;

function details(folder: ProjectFolderData, includeAudioSelection = true): Partial<ProjectDetails> {
  const projectDetails: Partial<ProjectDetails> = {
    name: folder.name,
    idea: folder.idea ?? "",
    key_points: folder.keyPoints ?? [],
    point_slides: folder.pointSlides ?? [],
    figma_url: folder.figmaUrl ?? null,
    script: folder.script,
  };
  if (includeAudioSelection) projectDetails.selected_audio_id = folder.audioId ?? null;
  return projectDetails;
}

export function folderFromProject(project: Project): ServerFolder {
  const attempts = project.attempts ?? [];
  const audios: FolderAudio[] = attempts.filter((attempt) => attempt.has_audio).reverse().map((attempt) => {
    const filename = attempt.audio_filename || `recording-${attempt.id.slice(0, 8)}`;
    return {
      id: attempt.id,
      folderId: project.id,
      filename,
      storageKey: audioKey(attempt.id),
      fileType: typeFromFilename(filename),
      durationS: attempt.duration_s,
      createdAt: attempt.created_at,
    };
  });
  const slideAttempt = attempts.find((attempt) => attempt.slides_filename) ?? null;
  const slide: FolderSlide | null = slideAttempt?.slides_filename
    ? {
        id: `${project.id}:slide`,
        folderId: project.id,
        title: slideAttempt.slides_filename,
        filename: slideAttempt.slides_filename,
        storageKey: slideKey(slideAttempt.id),
        fileType: typeFromFilename(slideAttempt.slides_filename),
        createdAt: slideAttempt.created_at,
      }
    : null;
  const selected = audios.find((audio) => audio.id === project.selected_audio_id) ?? audios.at(-1) ?? null;
  return normalizeFolder({
    id: project.id,
    name: project.name,
    slideName: slide?.filename ?? null,
    audioName: selected?.filename ?? null,
    audioId: selected?.id ?? null,
    audios,
    slide,
    idea: project.idea,
    keyPoints: project.key_points,
    pointSlides: project.point_slides ?? [],
    figmaUrl: project.figma_url,
    script: project.script || project.current.script,
    currentSessionId: project.current.session_id ?? null,
  });
}

export async function listServerFolders(): Promise<ServerFolder[]> {
  const projects = await api.listProjects();
  const full = await Promise.all(projects.map((project) => api.getProject(project.id)));
  return full.map(folderFromProject);
}

export async function createServerFolder(folder: ProjectFolderData): Promise<ServerFolder> {
  const project = await api.createProject(details(folder, false));
  return folderFromProject(project);
}

export async function updateServerFolder(folder: ServerFolder): Promise<ServerFolder> {
  const project = await api.updateProject(folder.id, details(folder));
  return folderFromProject(project);
}

export async function deleteServerFolder(folderId: string): Promise<void> {
  await api.deleteProject(folderId);
}

export async function fetchServerBlob(key: string): Promise<Blob | null> {
  const [kind, sessionId] = key.split(":", 2);
  if (kind === "api-audio" && sessionId) return api.audioBlob(sessionId);
  if (kind === "api-slide" && sessionId) return api.slidesFile(sessionId);
  return null;
}

export async function uploadServerAudio(folder: ServerFolder, file: Blob, filename: string): Promise<ServerFolder> {
  const attempt = await api.createAttempt(folder.id, true);
  await api.uploadAudio(attempt.id, file, filename);
  const updated = await api.updateProject(folder.id, { script: folder.script, selected_audio_id: attempt.id });
  return folderFromProject(updated);
}

export async function uploadServerSlide(folder: ServerFolder, file: Blob, filename: string): Promise<ServerFolder> {
  const attempt = await api.createAttempt(folder.id, true);
  const upload = new File([file], filename, { type: file.type || typeFromFilename(filename) });
  await api.uploadSlides(attempt.id, upload);
  return folderFromProject(await api.getProject(folder.id));
}

export async function deleteServerAudio(sessionId: string): Promise<void> {
  await api.deleteAudio(sessionId);
}

/** Transfer each browser's legacy folders to its own account before removing its local copies. */
export async function migrateLocalFolders(
  folders: ServerFolder[],
  getLocalBlob: (key: string) => Promise<Blob | null>,
  removeLocalData: (folders: ServerFolder[]) => Promise<void>,
  isCurrentAccount: () => boolean = () => true,
): Promise<void> {
  const ensureCurrentAccount = () => {
    if (!isCurrentAccount()) throw new Error("Account changed during local pitch migration.");
  };
  for (const folder of folders) {
    ensureCurrentAccount();
    const mappingKey = `pitchcoach:backend-project:${folder.id}`;
    const mappedId = localStorage.getItem(mappingKey);
    let project: Project | null = null;
    if (mappedId) {
      try {
        ensureCurrentAccount();
        project = await api.getProject(mappedId);
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.status !== 404) throw error;
      }
    }
    if (!project) {
      ensureCurrentAccount();
      project = await api.createProject(details({ ...folder, audioId: null }, false));
      ensureCurrentAccount();
      localStorage.setItem(mappingKey, project.id);
    } else {
      ensureCurrentAccount();
      project = await api.updateProject(project.id, details({ ...folder, id: project.id, audioId: null }));
    }

    let currentSessionId = project.current.session_id ?? null;
    const localSlide = folder.slide ? await getLocalBlob(folder.slide.storageKey) : null;
    ensureCurrentAccount();
    if (folder.slide && !localSlide) throw new Error(`Could not read the saved slide "${folder.slide.filename}".`);
    if (localSlide && folder.slide) {
      const slideMapKey = `pitchcoach:remote-slide:${folder.id}`;
      const existingSessionId = localStorage.getItem(slideMapKey);
      let remoteSlideSession = existingSessionId && project.attempts.some(
        (attempt) => attempt.id === existingSessionId && attempt.slides_filename,
      ) ? existingSessionId : null;
      if (!remoteSlideSession) {
        for (const attempt of project.attempts.filter((item) => item.slides_filename === folder.slide?.filename)) {
          try {
            ensureCurrentAccount();
            const remoteBlob = await api.slidesFile(attempt.id);
            if (await sameBlob(localSlide, remoteBlob)) {
              remoteSlideSession = attempt.id;
              break;
            }
          } catch {
            /* A candidate record with no file isn't the same saved slide. */
          }
        }
      }
      if (!remoteSlideSession) {
        ensureCurrentAccount();
        const attempt = await api.createAttempt(project.id, Boolean(currentSessionId));
        const upload = new File([localSlide], folder.slide.filename, { type: folder.slide.fileType });
        await api.uploadSlides(attempt.id, upload);
        ensureCurrentAccount();
        currentSessionId = attempt.id;
        localStorage.setItem(slideMapKey, attempt.id);
        project = await api.getProject(project.id);
      } else {
        ensureCurrentAccount();
        currentSessionId = remoteSlideSession;
        localStorage.setItem(slideMapKey, remoteSlideSession);
      }
    }

    const uploadedAudioIds: Record<string, string> = {};
    for (const audio of folder.audios ?? []) {
      ensureCurrentAccount();
      const audioMapKey = `pitchcoach:remote-audio:${folder.id}:${audio.id}`;
      const mappedSession = localStorage.getItem(audioMapKey);
      if (mappedSession && project.attempts.some((attempt) => attempt.id === mappedSession && attempt.has_audio)) {
        uploadedAudioIds[audio.id] = mappedSession;
        continue;
      }
      const blob = await getLocalBlob(audio.storageKey);
      ensureCurrentAccount();
      if (!blob) throw new Error(`Could not read the saved recording "${audio.filename}".`);
      let matchingAudio = null;
      for (const candidate of project.attempts.filter((attempt) => attempt.has_audio && attempt.audio_filename === audio.filename)) {
        if (Object.values(uploadedAudioIds).includes(candidate.id)) continue;
        try {
          ensureCurrentAccount();
          const remoteBlob = await api.audioBlob(candidate.id);
          if (await sameBlob(blob, remoteBlob)) {
            matchingAudio = candidate.id;
            break;
          }
        } catch {
          /* A candidate record without a playable file is not a match. */
        }
      }
      if (matchingAudio) {
        ensureCurrentAccount();
        localStorage.setItem(audioMapKey, matchingAudio);
        uploadedAudioIds[audio.id] = matchingAudio;
        currentSessionId = matchingAudio;
        continue;
      }
      const attempt = await api.createAttempt(project.id, Boolean(currentSessionId));
      await api.uploadAudio(attempt.id, blob, audio.filename);
      ensureCurrentAccount();
      localStorage.setItem(audioMapKey, attempt.id);
      uploadedAudioIds[audio.id] = attempt.id;
      currentSessionId = attempt.id;
      project = await api.getProject(project.id);
    }

    const selectedAudio = folder.audioId ? uploadedAudioIds[folder.audioId] : null;
    ensureCurrentAccount();
    project = await api.updateProject(project.id, {
      ...details({ ...folder, id: project.id, audioId: selectedAudio ?? null }),
      selected_audio_id: selectedAudio ?? null,
    });
    if (currentSessionId && !project.attempts.some((attempt) => attempt.id === currentSessionId)) {
      throw new Error("Uploaded folder data could not be verified on the backend.");
    }
  }
  ensureCurrentAccount();
  ensureCurrentAccount();
  await removeLocalData(folders);
}

async function sameBlob(left: Blob, right: Blob): Promise<boolean> {
  if (left.size !== right.size) return false;
  const [a, b] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", a),
    crypto.subtle.digest("SHA-256", b),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  return bytesA.every((value, index) => value === bytesB[index]);
}

function typeFromFilename(filename: string): string {
  const extension = filename.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    pdf: "application/pdf",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    wav: "audio/wav",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    webm: "audio/webm",
    ogg: "audio/ogg",
  };
  return extension ? types[extension] ?? "application/octet-stream" : "application/octet-stream";
}
