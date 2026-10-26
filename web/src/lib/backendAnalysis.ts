// "Full analysis (backend)": sends the folder's pitch through the FastAPI backend (the same
// pipeline as the project pages) and turns its report into the folder page's result shape.
// Based on Toka-1's #15.

import { api, ApiRequestError } from "./api";
import type { FolderMeta } from "./folderStore";
import type { MainPoints, ProjectDetails, Report } from "./types";

const POLL_MS = 2000;
const MAX_WAIT_MS = 5 * 60 * 1000; // the backend queues one analysis at a time on the GPU

export type BackendStage = "connecting" | "uploading" | "analyzing";

export interface BackendResult {
  summary: string;
  strengths: { text: string; quote: string }[];
  improvements: { source: "model"; title: string; why: string; action: string; example: string; quote: string }[];
  offTopic: { sentenceId: number; text: string; reason: string }[];
  mainPoints: {
    method: "llm" | "words";
    points: MainPoints["points"];
    coverage: number | null;
    ideaComment: string;
  } | null;
  received: { text: boolean; audio: string | null; slide: string | null };
  notes: string[];
}

/** A file name the backend accepts for the recording (it checks the extension). */
function audioName(file: Blob, saved: string | null): string {
  if (saved && /\.(wav|mp3|m4a|webm|ogg)$/i.test(saved)) return saved;
  const type = file.type;
  if (type.includes("mpeg")) return "audio.mp3";
  if (type.includes("wav")) return "audio.wav";
  if (type.includes("mp4") || type.includes("m4a")) return "audio.m4a";
  if (type.includes("ogg")) return "audio.ogg";
  return "audio.webm";
}

async function waitForReport(sessionId: string): Promise<Report> {
  const started = Date.now();
  while (Date.now() - started < MAX_WAIT_MS) {
    const status = await api.status(sessionId);
    if (status.status === "completed") return api.report(sessionId);
    if (status.status === "failed") throw new ApiRequestError({ code: "failed", message: status.error || "failed" }, 500);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new ApiRequestError({ code: "timeout", message: "timeout" }, 504);
}

/** The backend project for this folder: reused while it exists, created otherwise. */
async function projectFor(folder: FolderMeta): Promise<string> {
  const selectedAudio = folder.audios?.find((take) => take.id === folder.audioId) ?? null;
  const details: Partial<ProjectDetails> = {
    name: folder.name || "Saylo",
    idea: folder.idea ?? "",
    key_points: (folder.keyPoints ?? []).map((p) => p.trim()).filter(Boolean).slice(0, 6),
    point_slides: folder.pointSlides ?? [],
    figma_url: folder.figmaUrl ?? null,
    script: folder.script ?? "",
  };
  if (selectedAudio?.storageKey.startsWith("api-audio:")) details.selected_audio_id = selectedAudio.id;
  try {
    await api.updateProject(folder.id, details);
    return folder.id;
  } catch (err) {
    if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
  }

  const key = `pitchcoach:backend-project:${folder.id}`;
  let id: string | null = null;
  try {
    id = localStorage.getItem(key);
  } catch {
    /* storage blocked */
  }
  if (id) {
    try {
      await api.updateProject(id, details);
      return id;
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
    }
  }
  const newProjectDetails = { ...details };
  delete newProjectDetails.selected_audio_id;
  const project = await api.createProject(newProjectDetails);
  try {
    localStorage.setItem(key, project.id);
  } catch {
    /* storage blocked; a new project is made next time */
  }
  return project.id;
}

export async function runBackendAnalysis(args: {
  folder: FolderMeta;
  speech: string;
  audio: Blob | null;
  slide: Blob | null;
  onStage: (stage: BackendStage) => void;
  messages: { noAudio: string; slideSkipped: string };
}): Promise<BackendResult> {
  const { folder, speech, audio, slide, onStage, messages } = args;
  if (!audio) throw new Error(messages.noAudio);

  onStage("connecting");
  const projectId = await projectFor(folder);
  const selected = folder.audios?.find((take) => take.id === folder.audioId) ?? null;
  const savedAttemptId = selected?.storageKey.startsWith("api-audio:") ? selected.id : null;
  let attemptId = savedAttemptId;
  const audioFile = audioName(audio, folder.audioName);
  if (!attemptId) {
    onStage("uploading");
    const attempt = await api.createAttempt(projectId);
    attemptId = attempt.id;
    await api.uploadAudio(attemptId, audio, audioFile);
  }
  const notes: string[] = [];
  // Folder slides are PDFs (PowerPoint is converted on upload) or images; the backend takes PDF/PPTX.
  const isPdf = slide && (slide.type === "application/pdf" || /\.pdf$/i.test(folder.slideName ?? ""));
  if (slide && isPdf) {
    const name = /\.pdf$/i.test(folder.slideName ?? "") ? folder.slideName! : "slides.pdf";
    await api.uploadSlides(attemptId, new File([slide], name, { type: "application/pdf" }));
  } else if (slide) {
    notes.push(messages.slideSkipped);
  }
  if (speech) await api.setScript(attemptId, speech);

  onStage("analyzing");
  await api.analyze(attemptId);
  const report = await waitForReport(attemptId);
  const fb = report.feedback;
  const mp = fb.main_points;

  return {
    summary: fb.summary,
    strengths: fb.strengths.map((text) => ({ text, quote: "" })),
    improvements: fb.recommendations.map((r) => ({
      source: "model" as const,
      title: r.problem || r.area,
      why: r.why,
      action: r.action,
      example: r.example_sentence,
      quote: "",
    })),
    offTopic: (mp?.off_topic ?? []).map((o) => ({ sentenceId: o.sentence_id, text: o.text, reason: o.reason })),
    mainPoints:
      mp && mp.points.length
        ? { method: mp.method, points: mp.points, coverage: mp.coverage, ideaComment: mp.idea_comment }
        : null,
    received: { text: Boolean(speech), audio: audioFile, slide: isPdf ? folder.slideName : null },
    notes: [...report.notes, ...notes],
  };
}
