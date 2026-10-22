// Server only: the models the folder prototype can send a speech to.
import { readFileSync } from "node:fs";
import path from "node:path";

import { isProtoModel, type ModelStatus, type ProtoModel } from "@/lib/feedbackModels";
import { t, type Lang } from "@/lib/i18n";

export { isProtoModel };
export type { ProtoModel };

export class LlmError extends Error {
  readonly status: number;

  // Plain fields, not constructor shorthand: some compilers reset shorthand fields after the constructor.
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function fromEnvFiles(key: string): string {
  const files = [".env.local", ".env", path.join("..", ".env")].map((f) => path.join(process.cwd(), f));
  for (const file of files) {
    try {
      const line = readFileSync(file, "utf8")
        .split(/\r?\n/)
        .find((row) => row.startsWith(`${key}=`));
      const value = line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      /* This env file is not present. */
    }
  }
  return "";
}

function setting(key: string, fallback = "") {
  return process.env[key]?.trim() || fromEnvFiles(key) || fallback;
}

const ollamaUrl = () => setting("OLLAMA_URL", "http://localhost:11434").replace(/\/+$/, "");
const ollamaModel = () => setting("PITCH_OLLAMA_MODEL_BASE", "gemma4:e4b");
const claudeModel = () => setting("PITCH_CLAUDE_MODEL", "claude-opus-5-5");

export async function modelStatuses(lang: Lang): Promise<ModelStatus[]> {
  const claudeKey = Boolean(setting("ANTHROPIC_API_KEY"));
  let ollama: { available: boolean; reason: string | null };
  try {
    const res = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(2_000), cache: "no-store" });
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name ?? "");
    const want = ollamaModel();
    const pulled = names.some((n) => n === want || n.startsWith(`${want}:`));
    // The page asks for this list when it opens, so start loading the model now; the first
    // "send to model" then doesn't wait for it.
    if (pulled) void warmOllama();
    ollama = pulled
      ? { available: true, reason: null }
      : { available: false, reason: t(lang, "ollamaNotPulled", { m: want }) };
  } catch {
    ollama = { available: false, reason: t(lang, "ollamaDown") };
  }
  return [
    { id: "rules", name: t(lang, "rulesName"), local: true, available: true, reason: null },
    { id: "ollama", name: `Gemma · Ollama (${ollamaModel()})`, local: true, ...ollama },
    { id: "ollama-think", name: t(lang, "ollamaCarefulName", { m: ollamaModel() }), local: true, ...ollama },
    {
      id: "claude",
      name: `Claude (${claudeModel()})`,
      local: false,
      available: claudeKey,
      reason: claudeKey ? null : t(lang, "claudeKeyMissing"),
    },
  ];
}

export interface Improvement {
  // "measured": found by code (fillers, repeats, long sentences, numbers); "model": the model's advice.
  source: "measured" | "model";
  title: string;
  why: string;
  action: string;
  example: string;
  quote: string; // exact words from the speech; the route drops a model quote that isn't there
}

export interface Strength {
  text: string;
  quote: string; // the words that show it; strengths without a quote from the speech are dropped
}

/** A checked reply plus the raw JSON, so callers can read extra fields (main points) themselves. */
export interface ModelReply {
  summary: string;
  strengths: Strength[];
  improvements: Improvement[];
  raw: Record<string, unknown>;
}

export const MAX_IMPROVEMENTS = 5;
const MAX_STRENGTHS = 3;

const text = (value: unknown, max: number) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");

/**
 * Checks the model's JSON: {summary, strengths: [{text, quote}], improvements: [{title, why, action, example, quote}]}.
 * Each improvement needs a title and an action; at most MAX_IMPROVEMENTS are kept.
 * The older {points: [{title, detail}]} shape is read as improvements, so small models that drift still work.
 */
export function parseReply(raw: unknown): ModelReply | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const summary = text(body.summary, 800);
  if (!summary) return null;
  const list = Array.isArray(body.improvements) ? body.improvements : Array.isArray(body.points) ? body.points : null;
  if (!list) return null;
  const improvements: Improvement[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const i = item as Record<string, unknown>;
    const title = text(i.title, 120);
    const action = text(i.action ?? i.detail, 500);
    if (!title || !action) continue;
    improvements.push({ source: "model", title, why: text(i.why, 500), action, example: text(i.example, 400), quote: text(i.quote, 400) });
    if (improvements.length === MAX_IMPROVEMENTS) break;
  }
  const strengths = (Array.isArray(body.strengths) ? body.strengths : [])
    .map((v): Strength => {
      if (typeof v === "string") return { text: text(v, 300), quote: "" };
      const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
      return { text: text(o.text, 300), quote: text(o.quote, 400) };
    })
    .filter((v) => v.text)
    .slice(0, MAX_STRENGTHS);
  return { summary, strengths, improvements, raw: body };
}

function jsonFrom(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function askClaude(prompt: string, image: { mediaType: string; data: string } | null, lang: Lang) {
  const key = setting("ANTHROPIC_API_KEY");
  if (!key) throw new LlmError(t(lang, "claudeKeyMissing"), 503);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } });
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(50_000),
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: claudeModel(), max_tokens: 800, messages: [{ role: "user", content }] }),
    });
  } catch {
    throw new LlmError(t(lang, "llmUnreachable"), 502);
  }
  if (!response.ok) throw new LlmError(t(lang, "llmError", { status: response.status }), 502);
  const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const reply = parseReply(jsonFrom(payload.content?.find((b) => b.type === "text")?.text ?? ""));
  if (!reply) throw new LlmError(t(lang, "llmBadShape"), 502);
  return reply;
}

const str = { type: "string" } as const;

/** JSON schema for the reply; Ollama uses it to constrain the output to this shape. */
export function replySchema(withPoints: boolean, withNumbers = false): Record<string, unknown> {
  const obj = (props: Record<string, unknown>) => ({ type: "object", properties: props, required: Object.keys(props) });
  const properties: Record<string, unknown> = {
    summary: str,
    strengths: { type: "array", maxItems: 3, items: obj({ text: str, quote: str }) },
    improvements: {
      type: "array",
      maxItems: MAX_IMPROVEMENTS,
      items: obj({ title: str, why: str, action: str, example: str, quote: str }),
    },
    off_topic: { type: "array", items: obj({ sentence_id: { type: "integer" }, reason: str }) },
  };
  if (withNumbers) {
    properties.number_checks = {
      type: "array",
      items: obj({ on_slide: str, said: { type: ["string", "null"] }, inconsistent: { type: "boolean" } }),
    };
  }
  if (withPoints) {
    properties.point_checks = {
      type: "array",
      items: obj({ point: { type: "integer" }, status: { type: "string", enum: ["covered", "partial", "missed"] }, evidence: str, note: str }),
    };
    properties.idea_comment = str;
  }
  return obj(properties);
}

const OLLAMA_TRIES = 2; // small local models sometimes return a reply that doesn't validate

// How long Ollama keeps the model in GPU memory after a request. "-1" = until Ollama stops,
// so only the very first request pays the ~15 s load. Set e.g. "10m" to free the GPU sooner.
const keepAlive = () => {
  const value = setting("PITCH_OLLAMA_KEEP_ALIVE", "-1");
  return /^-?\d+$/.test(value) ? Number(value) : value;
};

/** Loads the model into memory without generating anything, if it isn't loaded already. */
export async function warmOllama(): Promise<void> {
  try {
    const ps = (await (await fetch(`${ollamaUrl()}/api/ps`, { signal: AbortSignal.timeout(2_000) })).json()) as {
      models?: { name?: string }[];
    };
    const want = ollamaModel();
    if ((ps.models ?? []).some((m) => m.name === want || m.name?.startsWith(`${want}:`))) return;
    // An empty prompt only loads the model. Not awaited by callers; errors are ignored.
    await fetch(`${ollamaUrl()}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: want, prompt: "", keep_alive: keepAlive() }),
    });
  } catch {
    /* Ollama isn't running; the model list already says so. */
  }
}

/** Reads Ollama's streamed chat reply (one JSON object per line) and returns the full text. */
async function readStream(response: Response, onText: (text: string) => void): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split("\n");
    buffered = done ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line) as { message?: { content?: string } };
        text += chunk.message?.content ?? "";
      } catch {
        /* a broken line; the final parse decides */
      }
    }
    onText(text);
    if (done) return text;
  }
}

/**
 * Asks the local model. With `onText`, the reply is streamed and `onText` gets the text so far
 * (it starts again from "" when a retry begins).
 */
export async function askOllama(
  prompt: string,
  lang: Lang,
  schema: Record<string, unknown> = replySchema(false),
  onText?: (text: string) => void,
  think = false,
) {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${ollamaUrl()}/api/chat`, {
        method: "POST",
        signal: AbortSignal.timeout(240_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: ollamaModel(),
          stream: Boolean(onText),
          format: schema,
          keep_alive: keepAlive(),
          // Gemma 4 "thinks" before answering by default: better judgement, but ~10 s before the
          // first word and about 2x slower. Only the "careful" choice turns it on.
          think,
          // Same settings as the pipeline (pipeline/feedback.py): long prompts need the larger context.
          options: { temperature: 0, num_ctx: 8192 },
          messages: [{ role: "user", content: prompt }],
        }),
      });
    } catch {
      throw new LlmError(t(lang, "ollamaUnreachable"), 502);
    }
    if (!response.ok) throw new LlmError(t(lang, "ollamaError", { status: response.status }), 502);
    let content: string;
    if (onText) {
      onText("");
      content = await readStream(response, onText);
    } else {
      content = ((await response.json()) as { message?: { content?: string } }).message?.content ?? "";
    }
    const reply = parseReply(jsonFrom(content));
    if (reply) return reply;
    if (attempt >= OLLAMA_TRIES) throw new LlmError(t(lang, "ollamaBadShape"), 502);
  }
}

/** What the no-LLM check needs to know about the main points. */
export interface PointStatus {
  text: string;
  status: "covered" | "partial" | "missed";
}

const SHORT_SPEECH_WORDS = 60;

/**
 * No model: things to improve from counts only. Fillers, repeats and long sentences come from
 * measureSpeech (shown for every model); this adds main points not found, slide words not
 * said, and a very short speech. Never quotes or invents speech.
 */
export function rulesReply(speech: string, slideText: string, lang: Lang, points: PointStatus[] = []): ModelReply {
  const words = speech.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const empty = { strengths: [], improvements: [], raw: {} };
  if (words.length === 0) return { summary: t(lang, "rulesNoText"), ...empty };

  const improvements: Improvement[] = [];
  const add = (title: string, why: string, action: string) =>
    improvements.push({ source: "measured", title, why, action, example: "", quote: "" });

  for (const p of points.filter((p) => p.status !== "covered").slice(0, 2)) {
    add(
      t(lang, "rulesPointTitle", { point: p.text }),
      t(lang, p.status === "missed" ? "rulesPointMissed" : "rulesPointPartial"),
      t(lang, "rulesPointAction"),
    );
  }
  if (slideText) {
    const slideWords = new Set((slideText.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 400));
    const said = new Set(words);
    const covered = [...slideWords].filter((w) => said.has(w)).length;
    if (slideWords.size && covered / slideWords.size < 0.5) {
      add(t(lang, "rulesSlide"), t(lang, "rulesSlideDetail", { total: slideWords.size, covered }), t(lang, "rulesSlideAction"));
    }
  }
  if (words.length < SHORT_SPEECH_WORDS) {
    add(t(lang, "rulesShortTitle"), t(lang, "rulesShortWhy", { n: words.length }), t(lang, "rulesShortAction"));
  }

  return { summary: t(lang, "rulesSummary", { n: words.length }), strengths: [], improvements, raw: {} };
}
