// Server only: the models the folder prototype can send a speech to.
import { readFileSync } from "node:fs";
import path from "node:path";

import { isProtoModel, type ModelStatus, type ProtoModel } from "@/lib/feedbackModels";
import { t, type Lang } from "@/lib/i18n";

export { isProtoModel };
export type { ProtoModel };

export interface Point {
  title: string;
  detail: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
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
    ollama = names.some((n) => n === want || n.startsWith(`${want}:`))
      ? { available: true, reason: null }
      : { available: false, reason: t(lang, "ollamaNotPulled", { m: want }) };
  } catch {
    ollama = { available: false, reason: t(lang, "ollamaDown") };
  }
  return [
    { id: "rules", name: t(lang, "rulesName"), local: true, available: true, reason: null },
    { id: "ollama", name: `Gemma · Ollama (${ollamaModel()})`, local: true, ...ollama },
    {
      id: "claude",
      name: `Claude (${claudeModel()})`,
      local: false,
      available: claudeKey,
      reason: claudeKey ? null : t(lang, "claudeKeyMissing"),
    },
  ];
}

/** Checks the model's JSON: {summary: string, points: [{title, detail}] (at most 3)}. */
export function parseReply(raw: unknown): { summary: string; points: Point[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.summary !== "string" || !body.summary.trim()) return null;
  if (!Array.isArray(body.points)) return null;
  const points: Point[] = [];
  for (const item of body.points.slice(0, 3)) {
    if (!item || typeof item !== "object") return null;
    const point = item as Record<string, unknown>;
    if (typeof point.title !== "string" || typeof point.detail !== "string") return null;
    const title = point.title.trim().slice(0, 120);
    const detail = point.detail.trim().slice(0, 500);
    if (!title || !detail) return null;
    points.push({ title, detail });
  }
  return { summary: body.summary.trim().slice(0, 800), points };
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

export async function askOllama(prompt: string, lang: Lang) {
  let response: Response;
  try {
    response = await fetch(`${ollamaUrl()}/api/chat`, {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel(),
        stream: false,
        format: "json",
        messages: [{ role: "user", content: prompt }],
      }),
    });
  } catch {
    throw new LlmError(t(lang, "ollamaUnreachable"), 502);
  }
  if (!response.ok) throw new LlmError(t(lang, "ollamaError", { status: response.status }), 502);
  const payload = (await response.json()) as { message?: { content?: string } };
  const reply = parseReply(jsonFrom(payload.message?.content ?? ""));
  if (!reply) throw new LlmError(t(lang, "ollamaBadShape"), 502);
  return reply;
}

let fillerCache: string[] | null = null;
function fillers(): string[] {
  if (fillerCache) return fillerCache;
  try {
    const file = path.join(process.cwd(), "..", "pipeline", "fillers_mn.txt");
    fillerCache = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"))
      .sort((a, b) => b.length - a.length);
  } catch {
    fillerCache = ["ээ", "ээм", "аан", "аа", "мм", "хмм", "нөгөө", "яахав"];
  }
  return fillerCache;
}

/** No model: counts fillers and back-to-back repeated words. Only quotes words that are in the text. */
export function rulesReply(text: string, slideText: string, lang: Lang): { summary: string; points: Point[] } {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) {
    return { summary: t(lang, "rulesNoText"), points: [] };
  }

  let joined = ` ${words.join(" ")} `;
  const found: string[] = [];
  let fillerTotal = 0;
  for (const f of fillers()) {
    const parts = joined.split(` ${f} `);
    const count = parts.length - 1;
    if (count > 0) {
      found.push(`«${f}» ×${count}`);
      fillerTotal += count;
      joined = parts.join(" ");
    }
  }

  const fillerSet = new Set(fillers());
  const repeats = new Map<string, number>();
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === words[i - 1] && w.length > 1 && !fillerSet.has(`${w} ${w}`)) repeats.set(w, (repeats.get(w) ?? 0) + 1);
  }

  const per100 = Math.round((fillerTotal / words.length) * 1000) / 10;
  const points: Point[] = [];
  points.push(
    fillerTotal
      ? { title: t(lang, "rulesFillers"), detail: t(lang, "rulesFillersFound", { list: found.join(", "), per100 }) }
      : { title: t(lang, "rulesFillers"), detail: t(lang, "rulesFillersNone") },
  );
  if (repeats.size) {
    points.push({
      title: t(lang, "rulesRepeats"),
      detail: [...repeats].map(([w, n]) => `«${w} ${w}» ×${n}`).join(", "),
    });
  }
  if (slideText) {
    const slideWords = new Set((slideText.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).slice(0, 400));
    const said = new Set(words);
    const covered = [...slideWords].filter((w) => said.has(w)).length;
    points.push({
      title: t(lang, "rulesSlide"),
      detail: t(lang, "rulesSlideDetail", { total: slideWords.size, covered }),
    });
  }
  return {
    summary: t(lang, "rulesSummary", { n: words.length }),
    points: points.slice(0, 3),
  };
}
