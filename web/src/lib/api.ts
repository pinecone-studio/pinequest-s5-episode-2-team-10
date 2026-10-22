import type {
  ApiError,
  AudioUploadResult,
  CreateSessionBody,
  CreatedSession,
  FeedbackBackend,
  Report,
  SlidesUploadResult,
  StatusResponse,
} from "./types";
import { mockApi } from "./mock";

const API_URL = process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "");
export const USING_MOCK = !API_URL;

const BASE = `${API_URL}/api/v1`;
const TOKEN_HEADER = "X-Access-Token";

export class ApiRequestError extends Error {
  code: string;
  constructor({ code, message }: ApiError) {
    super(message);
    this.code = code;
  }
}

// Each session's access token lives in local storage and is sent as a header.
const tokenKey = (id: string) => `pitchcoach:token:${id}`;

export function saveToken(id: string, token: string) {
  try {
    localStorage.setItem(tokenKey(id), token);
  } catch {}
}

function getToken(id: string): string {
  try {
    return localStorage.getItem(tokenKey(id)) ?? "";
  } catch {
    return "";
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { sessionId?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.sessionId) headers.set(TOKEN_HEADER, getToken(init.sessionId));
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers });
  } catch {
    throw new ApiRequestError({
      code: "network",
      message: "Could not reach the server. Is the backend running?",
    });
  }

  if (!res.ok) {
    let err: ApiError = { code: String(res.status), message: res.statusText };
    try {
      err = await res.json();
    } catch {}
    throw new ApiRequestError(err);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

function upload<T>(id: string, kind: "audio" | "slides", file: Blob, filename: string) {
  const form = new FormData();
  form.append("file", file, filename);
  return request<T>(`/sessions/${id}/${kind}`, {
    method: "POST",
    body: form,
    sessionId: id,
  });
}

const realApi = {
  createSession: (body: CreateSessionBody) =>
    request<CreatedSession>("/sessions", { method: "POST", body: JSON.stringify(body) }),

  uploadSlides: (id: string, file: File) =>
    upload<SlidesUploadResult>(id, "slides", file, file.name),

  uploadAudio: (id: string, file: Blob, filename: string) =>
    upload<AudioUploadResult>(id, "audio", file, filename),

  analyze: (id: string, feedback_backend: FeedbackBackend) =>
    request<void>(`/sessions/${id}/analyze`, {
      method: "POST",
      body: JSON.stringify({ feedback_backend }),
      sessionId: id,
    }),

  status: (id: string) => request<StatusResponse>(`/sessions/${id}/status`, { sessionId: id }),

  report: (id: string) => request<Report>(`/sessions/${id}/report`, { sessionId: id }),

  deleteSession: (id: string) =>
    request<void>(`/sessions/${id}`, { method: "DELETE", sessionId: id }),
};

export type Api = typeof realApi;

export const api: Api = USING_MOCK ? mockApi : realApi;
