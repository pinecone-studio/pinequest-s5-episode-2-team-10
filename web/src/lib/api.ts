import type {
  ApiError,
  AdminUser,
  Attempt,
  AudioUploadResult,
  AuthSession,
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
import { clearSession, readToken } from "./session";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
export const USING_MOCK = !API_URL;

// The browser calls this app. next.config forwards /api/v1 to NEXT_PUBLIC_API_URL,
// so a deployed site can reach the API without that host allowing our origin.
const BASE = "/api/v1";
const REQUEST_TIMEOUT_MS = 25_000;
const UPLOAD_TIMEOUT_MS = 120_000; // a 25 MB recording on a slow connection
export class ApiRequestError extends Error {
  code: string;
  status: number;
  constructor({ code, message }: ApiError, status = 0) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function requireToken(): string {
  const token = readToken();
  if (!token) {
    clearSession();
    throw new ApiRequestError({ code: "unauthorized", message: "Sign in required." }, 401);
  }
  return token;
}

async function send<T>(path: string, init: RequestInit, token: string | null, as: "json" | "blob" = "json"): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("X-Access-Token", token);
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const timedOut = err instanceof DOMException && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ApiRequestError({
      code: timedOut ? "timeout" : "network",
      message: timedOut ? "The backend took too long to answer. Try again." : "Could not reach the server. Is the backend running?",
    });
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
    return await send<T>(path, init, requireToken(), as);
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 401) clearSession();
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
  return request<T>(`/sessions/${id}/${kind}`, { method: "POST", body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
}

const realApi = {
  register: (email: string, password: string) =>
    send<AuthSession>("/auth/register", json("POST", { email, password }), null),
  login: (email: string, password: string) => send<AuthSession>("/auth/login", json("POST", { email, password }), null),
  demo: async () => {
    try {
      return await send<AuthSession>("/auth/demo", { method: "POST" }, null);
    } catch (err) {
      // The GPU PC still serves the older API, which creates an anonymous user at POST /users.
      if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
      const created = await send<{ id: string; access_token: string }>("/users", { method: "POST" }, null);
      return { id: created.id, email: "demo@pitchcoach.local", role: "member" as const, access_token: created.access_token };
    }
  },
  google: (accessToken: string) =>
    send<AuthSession>("/auth/google", json("POST", { access_token: accessToken }), null),
  me: () => request<{ id: string; email: string; role: "member" | "admin" }>("/auth/me"),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  adminUsers: () => request<AdminUser[]>("/admin/users"),
  updateAdminUser: (id: string, changes: { role?: "member" | "admin"; is_active?: boolean }) =>
    request<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, json("PATCH", changes)),

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

  // Without a model, the backend uses its default (PITCH_DEFAULT_BACKEND).
  analyze: (id: string, feedback_backend?: FeedbackBackend) =>
    request<void>(`/sessions/${id}/analyze`, json("POST", feedback_backend ? { feedback_backend } : {})),
  status: (id: string) => request<StatusResponse>(`/sessions/${id}/status`),
  report: (id: string) => request<Report>(`/sessions/${id}/report`),

  // Uploaded files come back as blobs because <audio src> can't send the token header.
  audioBlob: (id: string) => request<Blob>(`/sessions/${id}/audio`, {}, "blob"),
  slidesText: (id: string) => request<{ filename: string | null; slides: SlideText[] }>(`/sessions/${id}/slides`),
  slidesFile: (id: string) => request<Blob>(`/sessions/${id}/slides/file`, {}, "blob"),
};

export type Api = typeof realApi;

export const api: Api = USING_MOCK ? mockApi : realApi;
