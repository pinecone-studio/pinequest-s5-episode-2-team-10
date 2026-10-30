// A pitch's takes over time: the numbers each saved analysis measured, and what changed since the
// previous take. Only numbers measured by code are compared (main points, fillers, pace, pauses,
// volume at the end), never the model's wording, which varies from run to run.
import type { MessageKey } from "./i18n";
import type { Attempt, Report } from "./types";

export type PointStatus = "covered" | "partial" | "missed";

export interface Take {
  id: string;
  createdAt: string;
  audio: string | null; // which recording: file name and length (new recordings all share one name)
  points: { text: string; status: PointStatus }[];
  covered: number;
  total: number;
  fillersPer100: number | null;
  wpm: number | null;
  longPausesPerMin: number | null;
  endVolumeDropDb: number | null;
  numberIssues: { onSlide: string; said: string | null }[]; // slide figures said differently
  fillerWords: string[]; // the fillers this speaker used, most frequent first
  // Delivery problems the analysis found by code (rushed ending, long silences, fading voice, …).
  delivery: { problem: string; action: string }[];
  // The analysis's other fixes (the model's, or the rule-based fallback's), most important first.
  // Missing on takes saved before this was kept.
  fixes?: { problem: string; action: string }[];
  example?: boolean; // a bundled example take (demo account), not the speaker's own
  alsoIds?: string[]; // earlier analyses of the same recording, hidden behind this one (deleted with it)
}

/**
 * Example takes shipped with the demo pitches, so the demo account shows practice over time before
 * anyone records. Real analyses of recordings made for the demo (scripts/demo_takes); labelled
 * "Example" on the page. Keyed by demo folder id.
 */
export const EXAMPLE_TAKES: Record<string, string> = {
  "d97bd0e5-9bd0-4c18-abde-debcddd552f7": "/defaults/demo/agaar-takes.json", // Агаар
};

/** The example takes for a demo folder ([] when it has none or they can't be loaded). */
export async function loadExampleTakes(folderId: string): Promise<Take[]> {
  const url = EXAMPLE_TAKES[folderId];
  if (!url) return [];
  try {
    const res = await fetch(url, { cache: "force-cache" });
    if (!res.ok) return [];
    const rows = (await res.json()) as { attempt: Attempt; report: Report }[];
    return rows.map((r) => ({ ...takeFrom(r.attempt, r.report), example: true }));
  } catch {
    return [];
  }
}

export type Trend = "better" | "worse" | "same" | "info";

export interface Change {
  trend: Trend;
  key: MessageKey;
  vars: Record<string, string | number>;
}

export const MAX_TAKES = 5;

// Smaller differences than these are measurement noise, not a change worth reporting.
const FILLERS_STEP = 0.5; // per 100 words
const PAUSES_STEP = 0.3; // long pauses per minute
const VOLUME_STEP = 2; // dB
const PACE_STEP = 10; // words per minute

const RANK: Record<PointStatus, number> = { missed: 0, partial: 1, covered: 2 };
const sameText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const round1 = (n: number) => Math.round(n * 10) / 10;

/** One take from a saved analysis. A point whose quote wasn't in the transcript counts as missed. */
const MAX_FIXES = 3;

export function takeFrom(attempt: Attempt, report: Report): Take {
  const points = (report.feedback.main_points?.points ?? []).map((p) => ({
    text: p.text,
    status: (p.verified ? p.status : "missed") as PointStatus,
  }));
  const m = report.metrics;
  return {
    id: attempt.id,
    createdAt: attempt.created_at,
    audio: attempt.audio_filename ? `${attempt.audio_filename}|${attempt.duration_s?.toFixed(2) ?? ""}` : null,
    points,
    covered: points.filter((p) => p.status === "covered").length,
    total: points.length,
    fillersPer100: m.fillers_per_100,
    wpm: m.wpm,
    longPausesPerMin: m.long_pauses_per_min,
    endVolumeDropDb: m.end_volume_drop_db,
    numberIssues: (report.feedback.number_checks ?? [])
      .filter((n) => n.inconsistent)
      .map((n) => ({ onSlide: n.on_slide, said: n.said })),
    fillerWords: [...(report.feedback.fillers?.words ?? [])].sort((a, b) => b.count - a.count).map((w) => w.word),
    delivery: (report.feedback.recommendations ?? [])
      .filter((r) => r.area === "delivery" && r.source === "measured" && r.problem)
      .map((r) => ({ problem: r.problem, action: r.action })),
    fixes: (report.feedback.recommendations ?? [])
      .filter((r) => r.problem && !(r.area === "delivery" && r.source === "measured"))
      .slice(0, MAX_FIXES)
      .map((r) => ({ problem: r.problem, action: r.action })),
  };
}

/**
 * Takes in time order, oldest first: completed analyses only, and only the latest analysis of
 * each recording (analysing the same file again isn't a new take). At most MAX_TAKES, the newest.
 */
export function orderTakes(takes: Take[]): Take[] {
  const latest = new Map<string, Take>();
  for (const take of [...takes].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = take.audio ?? take.id;
    const before = latest.get(key);
    latest.set(key, before ? { ...take, alsoIds: [...(before.alsoIds ?? []), before.id] } : take);
  }
  return [...latest.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-MAX_TAKES);
}

/** Lower is better for this number; returns the trend from `before` to `after`. */
function lowerIsBetter(before: number | null, after: number | null, step: number): Trend | null {
  if (before == null || after == null) return null;
  if (Math.abs(after - before) < step) return "same";
  return after < before ? "better" : "worse";
}

/** The trend of one table cell against the previous take (null for the first take or a missing value). */
export function cellTrend(metric: "points" | "fillers" | "wpm" | "pauses" | "volume", prev: Take | undefined, cur: Take): Trend | null {
  if (!prev) return null;
  switch (metric) {
    case "points":
      if (!cur.total || !prev.total) return null;
      return cur.covered === prev.covered ? "same" : cur.covered > prev.covered ? "better" : "worse";
    case "fillers":
      return lowerIsBetter(prev.fillersPer100, cur.fillersPer100, FILLERS_STEP);
    case "pauses":
      return lowerIsBetter(prev.longPausesPerMin, cur.longPausesPerMin, PAUSES_STEP);
    case "volume":
      return lowerIsBetter(prev.endVolumeDropDb, cur.endVolumeDropDb, VOLUME_STEP);
    case "wpm":
      // Faster or slower isn't better by itself; only a clear change is shown, without a verdict.
      return prev.wpm == null || cur.wpm == null ? null : Math.abs(cur.wpm - prev.wpm) < PACE_STEP ? "same" : "info";
  }
}

/**
 * What changed from `prev` to `cur`, most important first: main points (by their text), then
 * fillers, long pauses, the volume at the end, and pace.
 */
export function compareTakes(prev: Take, cur: Take): Change[] {
  const changes: Change[] = [];
  const before = new Map(prev.points.map((p) => [sameText(p.text), p.status]));
  const pointChanges: Change[] = [];
  const stillMissed: Change[] = [];
  for (const p of cur.points) {
    const was = before.get(sameText(p.text));
    if (was === undefined) continue; // a new point: nothing to compare with
    const vars = { point: p.text };
    if (RANK[p.status] > RANK[was]) {
      pointChanges.push({ trend: "better", key: p.status === "covered" ? "takeNowCovered" : "takeNowPartly", vars });
    } else if (RANK[p.status] < RANK[was]) {
      pointChanges.push({ trend: "worse", key: p.status === "missed" ? "takeNowMissed" : "takeNowOnlyPartly", vars });
    } else if (p.status === "missed") {
      stillMissed.push({ trend: "worse", key: "takeStillMissed", vars });
    }
  }
  changes.push(...pointChanges.filter((c) => c.trend === "worse"), ...stillMissed, ...pointChanges.filter((c) => c.trend === "better"));

  const fillers = lowerIsBetter(prev.fillersPer100, cur.fillersPer100, FILLERS_STEP);
  if (fillers === "better" || fillers === "worse") {
    changes.push({ trend: fillers, key: "takeFillers", vars: { from: round1(prev.fillersPer100!), to: round1(cur.fillersPer100!) } });
  }
  const pauses = lowerIsBetter(prev.longPausesPerMin, cur.longPausesPerMin, PAUSES_STEP);
  if (pauses === "better" || pauses === "worse") {
    changes.push({ trend: pauses, key: "takePauses", vars: { from: round1(prev.longPausesPerMin!), to: round1(cur.longPausesPerMin!) } });
  }
  const volume = lowerIsBetter(prev.endVolumeDropDb, cur.endVolumeDropDb, VOLUME_STEP);
  if (volume === "better" || volume === "worse") {
    changes.push({ trend: volume, key: "takeVolume", vars: { from: round1(prev.endVolumeDropDb!), to: round1(cur.endVolumeDropDb!) } });
  }
  if (cellTrend("wpm", prev, cur) === "info") {
    changes.push({ trend: "info", key: "takePace", vars: { from: Math.round(prev.wpm!), to: Math.round(cur.wpm!) } });
  }
  return changes;
}
