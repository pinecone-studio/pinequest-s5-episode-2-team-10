// Server only: talks to the local voice server (voice/server.py). Never import from a client component.
import { readFileSync } from "node:fs";
import path from "node:path";
import { t, type Lang } from "@/lib/i18n";

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
  readonly status: number;

  // Plain fields, not constructor shorthand: some compilers reset shorthand fields after the constructor.
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** Reads KEY=value from env files: web/.env.local, web/.env, then the repo's .env.voice and .env. */
function fromEnvFiles(key: string): string {
  const files = [".env.local", ".env", path.join("..", ".env.voice"), path.join("..", ".env")].map((f) =>
    path.join(/*turbopackIgnore: true*/ process.cwd(), f), // local development only; hosts provide process.env
  );
  for (const file of files) {
    try {
      const line = readFileSync(/*turbopackIgnore: true*/ file, "utf8")
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

/** A server setting: the environment first, then the env files above (local development). */
export function serverSetting(key: string): string {
  return process.env[key]?.trim() || fromEnvFiles(key);
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

export async function voiceHealth(lang: Lang): Promise<{ ok: boolean; device?: string; modelLoaded?: boolean; busy?: boolean; error?: string }> {
  const { url } = voiceConfig();
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!res.ok) return { ok: false, error: t(lang, "voiceError", { status: res.status }) };
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: body.ok === true,
      device: typeof body.device === "string" ? body.device : undefined,
      modelLoaded: body.model_loaded === true,
      busy: body.busy === true,
    };
  } catch {
    return { ok: false, error: t(lang, "voiceDown") };
  }
}

// The speech model returns no punctuation. A pause this long ends a sentence, so the text
// reaches the feedback model (and its quotes) as real sentences instead of one long run.
const SENTENCE_PAUSE_S = 0.6;
const ENDS_SENTENCE = /[.?!…]$/;

/** Words joined into text, with a full stop wherever the speaker paused for SENTENCE_PAUSE_S or more. */
export function textWithPauses(words: VoiceWord[]): string {
  let out = "";
  words.forEach((w, i) => {
    if (i > 0) out += w.start - words[i - 1].end >= SENTENCE_PAUSE_S && !ENDS_SENTENCE.test(out) ? ". " : " ";
    out += w.word;
  });
  return out && !ENDS_SENTENCE.test(out) ? `${out}.` : out;
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
    text: textWithPauses(words),
    words,
    durationS: num(body.duration_s),
    elapsedS: num(body.elapsed_s),
  };
}

export async function transcribe(file: Blob, name: string, lang: Lang): Promise<VoiceResult> {
  const { url, token } = voiceConfig();
  if (!token) throw new VoiceError(t(lang, "voiceTokenMissing"), 503);
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
    throw new VoiceError(t(lang, "voiceDown"), 502);
  }
  if (res.status === 401) throw new VoiceError(t(lang, "voiceTokenWrong"), 502);
  if (!res.ok) {
    let message = t(lang, "voiceError", { status: res.status });
    try {
      const body = (await res.json()) as { message?: unknown };
      if (typeof body.message === "string") message = body.message;
    } catch {
      /* not JSON */
    }
    throw new VoiceError(message, res.status >= 500 ? 502 : 400);
  }
  const parsed = parseVoiceReply(await res.json().catch(() => null));
  if (!parsed) throw new VoiceError(t(lang, "voiceBadReply"), 502);
  return parsed;
}
