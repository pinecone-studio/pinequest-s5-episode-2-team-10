// What the admin Status tab has seen of each part since it was opened: how long it has been in
// its current state, when it last worked, its last error, and its recent changes.
// Kept in the browser (this tab's session); the services don't keep a history themselves.

export type Health = "ok" | "warn" | "down" | "checking";

export interface Change {
  at: string;
  from: Health | null;
  to: Health;
  error?: string;
}

export interface PartHistory {
  health: Health;
  since: string; // when it entered its current state (as far as this page has seen)
  lastOkAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  checks: number;
  problems: number; // checks that weren't "ok"
  changes: Change[]; // newest first, at most MAX_CHANGES
}

export type History = Record<string, PartHistory>;

export const MAX_CHANGES = 10;
const STORAGE_KEY = "saylo:status-history";

/** Adds one round of checks (taken at `at`) to the history. "checking" results are ignored. */
export function recordChecks(history: History, parts: { key: string; health: Health; error?: string }[], at: string): History {
  const next: History = { ...history };
  for (const part of parts) {
    if (part.health === "checking") continue;
    const before = next[part.key];
    const changed = !before || before.health !== part.health;
    const problem = part.health !== "ok";
    next[part.key] = {
      health: part.health,
      since: changed ? at : before.since,
      lastOkAt: part.health === "ok" ? at : (before?.lastOkAt ?? null),
      lastError: problem && part.error ? part.error : (before?.lastError ?? null),
      lastErrorAt: problem && part.error ? at : (before?.lastErrorAt ?? null),
      checks: (before?.checks ?? 0) + 1,
      problems: (before?.problems ?? 0) + (problem ? 1 : 0),
      changes: changed
        ? [{ at, from: before?.health ?? null, to: part.health, ...(part.error ? { error: part.error } : {}) }, ...(before?.changes ?? [])].slice(0, MAX_CHANGES)
        : before.changes,
    };
  }
  return next;
}

export function loadHistory(): History {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as History) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function saveHistory(history: History) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* storage blocked or full: the history just isn't kept across reloads */
  }
}

/** Whole minutes, hours and days between two times, for "up for …" (null when either is missing). */
export function span(fromIso: string | null | undefined, toIso: string | null | undefined): { d: number; h: number; m: number } | null {
  if (!fromIso || !toIso) return null;
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const minutes = Math.floor(ms / 60_000);
  return { d: Math.floor(minutes / 1440), h: Math.floor((minutes % 1440) / 60), m: minutes % 60 };
}
