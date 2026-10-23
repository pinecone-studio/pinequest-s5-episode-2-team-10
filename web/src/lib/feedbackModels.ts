// Models the folder prototype can send a speech to. Shared by the browser and the server.

// "ollama-think" is the same Gemma with its step-by-step thinking on: slower, more careful.
// "backend" runs the full FastAPI pipeline (as the project pages do); the browser calls it directly.
export const PROTO_MODELS = ["rules", "ollama", "ollama-think", "claude", "backend"] as const;
export type ProtoModel = (typeof PROTO_MODELS)[number];

export interface ModelStatus {
  id: ProtoModel;
  name: string;
  local: boolean;
  server?: boolean; // runs on the app's own backend, not on this PC or a cloud API
  available: boolean;
  reason: string | null;
}

/**
 * "Full analysis (backend)" is offered in development, or when NEXT_PUBLIC_FULL_ANALYSIS=1. It
 * needs the backend, a recording and a PDF deck, and the folder page shows only its text, so the
 * demo site leaves it out.
 */
export const FULL_ANALYSIS_ENABLED =
  process.env.NODE_ENV === "development" || process.env.NEXT_PUBLIC_FULL_ANALYSIS === "1";

export function isProtoModel(value: unknown): value is ProtoModel {
  return typeof value === "string" && (PROTO_MODELS as readonly string[]).includes(value);
}

export function parseModelStatuses(raw: unknown): ModelStatus[] | null {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { models?: unknown }).models)) return null;
  const out: ModelStatus[] = [];
  for (const item of (raw as { models: unknown[] }).models) {
    if (!item || typeof item !== "object") return null;
    const m = item as Record<string, unknown>;
    if (!isProtoModel(m.id) || typeof m.name !== "string" || typeof m.available !== "boolean") return null;
    out.push({
      id: m.id,
      name: m.name,
      local: m.local === true,
      server: m.server === true,
      available: m.available,
      reason: typeof m.reason === "string" ? m.reason : null,
    });
  }
  return out;
}
