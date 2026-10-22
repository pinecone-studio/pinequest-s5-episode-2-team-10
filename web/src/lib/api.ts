import type {
  ApiError,
  Attempt,
  AudioUploadResult,
  FeedbackBackend,
  Project,
  ProjectDetails,
  ProjectSummary,
  Report,
  SlideText,
  SlidesUploadResult,
  StatusResponse,
} from "./types";
import { mockApi } from "./mock";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
export const USING_MOCK = !API_URL;

const BASE = `${API_URL}/api/v1`;
const TOKEN_KEY = "pitchcoach:user-token";

export class ApiRequestError extends Error {
  code: string;
  status: number;
  constructor({ code, message }: ApiError, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// No logins yet: this browser gets an anonymous user once and keeps its token.
let tokenPromise: Promise<string> | null = null;

function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function getToken(): Promise<string> {
  const saved = storedToken();
  if (saved) return Promise.resolve(saved);
  tokenPromise ??= (async () => {
    const res = await send<{ access_token: string }>("/users", { method: "POST" }, null);
    try {
      localStorage.setItem(TOKEN_KEY, res.access_token);
    } catch {}
    return res.access_token;
  })().finally(() => {
    tokenPromise = null;
  });
  return tokenPromise;
}

async function send<T>(path: string, init: RequestInit, token: string | null, as: "json" | "blob" = "json"): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Access-Token", token);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiRequestError({ code: "network", message: "Could not reach the server. Is the backend running?" });
  }
  if (!res.ok) {
    let err: ApiError = { code: String(res.status), message: res.statusText || "Request failed." };
    try {
      err = await res.json();
    } catch {}
    throw new ApiRequestError(err, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (as === "blob" ? res.blob() : res.json()) as Promise<T>;
}

async function request<T>(path: string, init: RequestInit = {}, as: "json" | "blob" = "json"): Promise<T> {
  try {
    return await send<T>(path, init, await getToken(), as);
  } catch (e) {
    // Token unknown to the server (e.g. database was reset): start a fresh user once.
    if (e instanceof ApiRequestError && e.status === 401) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {}
      return send<T>(path, init, await getToken(), as);
    }
    throw e;
  }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

function upload<T>(id: string, kind: "audio" | "slides", file: Blob, filename: string) {
  const form = new FormData();
  form.append("file", file, filename);
  return request<T>(`/sessions/${id}/${kind}`, { method: "POST", body: form });
}

const realApi = {
  listProjects: () => request<ProjectSummary[]>("/projects"),
  createProject: (details: Partial<ProjectDetails> = {}) => request<Project>("/projects", json("POST", details)),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  updateProject: (id: string, patch: Partial<ProjectDetails>) => request<Project>(`/projects/${id}`, json("PATCH", patch)),
  deleteProject: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),

  createAttempt: (projectId: string) => request<Attempt>(`/projects/${projectId}/sessions`, json("POST", { copy_inputs: true })),
  deleteAttempt: (id: string) => request<void>(`/sessions/${id}`, { method: "DELETE" }),

  uploadSlides: (id: string, file: File) => upload<SlidesUploadResult>(id, "slides", file, file.name),
  removeSlides: (id: string) => request<void>(`/sessions/${id}/slides`, { method: "DELETE" }),
  setScript: (id: string, text: string) => request<{ words: number }>(`/sessions/${id}/script`, json("PUT", { text })),
  uploadAudio: (id: string, file: Blob, filename: string) => upload<AudioUploadResult>(id, "audio", file, filename),

  analyze: (id: string, feedback_backend: FeedbackBackend) =>
    request<void>(`/sessions/${id}/analyze`, json("POST", { feedback_backend })),
  status: (id: string) => request<StatusResponse>(`/sessions/${id}/status`),
  report: (id: string) => request<Report>(`/sessions/${id}/report`),

  // Uploaded files come back as blobs because <audio src> can't send the token header.
  audioBlob: (id: string) => request<Blob>(`/sessions/${id}/audio`, {}, "blob"),
  slidesText: (id: string) => request<{ filename: string | null; slides: SlideText[] }>(`/sessions/${id}/slides`),
  slidesFile: (id: string) => request<Blob>(`/sessions/${id}/slides/file`, {}, "blob"),
};

export type Api = typeof realApi;

export const api: Api = USING_MOCK ? mockApi : realApi;
