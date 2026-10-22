// Server only: talks to the local voice server (voice/server.py). Never import from a client component.
import { readFileSync } from "node:fs";
import path from "node:path";

export interface VoiceWord {
  word: string;
  start: number;
  end: number;
}

export interface VoiceResult {
  text: string;
  words: VoiceWord[];
  durationS: number;
  elapsedS: number;
}

export class VoiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Reads KEY=value from env files: web/.env.local, web/.env, then the repo's .env.voice and .env. */
function fromEnvFiles(key: string): string {
  const files = [".env.local", ".env", path.join("..", ".env.voice"), path.join("..", ".env")].map((f) =>
    path.join(process.cwd(), f),
  );
  for (const file of files) {
    try {
      const line = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .map((row) => row.trim()) // trim also drops the byte-order mark PowerShell writes
        .find((row) => row.startsWith(`${key}=`));
      const value = line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      /* This env file is not present. */
    }
  }
  return "";
}

export function voiceConfig() {
  const url = (process.env.PITCH_VOICE_URL?.trim() || fromEnvFiles("PITCH_VOICE_URL") || "http://127.0.0.1:8001").replace(
    /\/+$/,
    "",
  );
  const token =
    process.env.PITCH_VOICE_TOKEN?.trim() || fromEnvFiles("PITCH_VOICE_TOKEN") || fromEnvFiles("VOICE_SERVER_TOKEN");
  return { url, token };
}

export async function voiceHealth(): Promise<{ ok: boolean; device?: string; modelLoaded?: boolean; busy?: boolean; error?: string }> {
  const { url } = voiceConfig();
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!res.ok) return { ok: false, error: `Дуу хоолойн сервер алдаа өглөө (${res.status}).` };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: body.ok === true,
      device: typeof body.device === "string" ? body.device : undefined,
      modelLoaded: body.model_loaded === true,
      busy: body.busy === true,
    };
  } catch {
    return { ok: false, error: "Дуу хоолойн сервер ажиллахгүй байна. scripts\\voice.ps1-ийг асаана уу." };
  }
}

/** Checks the voice server reply: {words: [{word, start, end}], duration_s, elapsed_s}. */
export function parseVoiceReply(raw: unknown): VoiceResult | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (!Array.isArray(body.words)) return null;
  const words: VoiceWord[] = [];
  for (const item of body.words) {
    if (!item || typeof item !== "object") return null;
    const w = item as Record<string, unknown>;
    if (typeof w.word !== "string" || typeof w.start !== "number" || typeof w.end !== "number") return null;
    if (w.word.trim()) words.push({ word: w.word.trim(), start: w.start, end: w.end });
  }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    text: words.map((w) => w.word).join(" "),
    words,
    durationS: num(body.duration_s),
    elapsedS: num(body.elapsed_s),
  };
}

export async function transcribe(file: Blob, name: string): Promise<VoiceResult> {
  const { url, token } = voiceConfig();
  if (!token) throw new VoiceError("PITCH_VOICE_TOKEN алга (.env.voice эсвэл web/.env.local).", 503);
  const form = new FormData();
  form.set("file", file, name);
  let res: Response;
  try {
    res = await fetch(`${url}/v1/transcribe`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new VoiceError("Дуу хоолойн сервер ажиллахгүй байна. scripts\\voice.ps1-ийг асаана уу.", 502);
  }
  if (res.status === 401) throw new VoiceError("Дуу хоолойн серверийн токен таарсангүй.", 502);
  if (!res.ok) {
    let message = `Дуу хоолойн сервер алдаа өглөө (${res.status}).`;
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      /* not JSON */
    }
    throw new VoiceError(message, res.status >= 500 ? 502 : 400);
  }
  const parsed = parseVoiceReply(await res.json().catch(() => null));
  if (!parsed) throw new VoiceError("Дуу хоолойн серверийн хариу буруу хэлбэртэй байна.", 502);
  return parsed;
}
