// The goal for a pitch's next take, and quick drills that check only that goal.
// Fixed rules, no model: the goal is the most important problem left in the latest take (missed
// main points first), and a drill is a short recording checked in the browser.
import type { MessageKey } from "./i18n";
import { rulesCheck, toSentences } from "./server/points"; // plain functions, safe in the browser
import type { Take } from "./takes";

// Above this many fillers per 100 words, fillers become the goal; a drill passes at or below DRILL_FILLERS.
export const FILLER_GOAL = 3;
export const DRILL_FILLERS = 2;
export const PAUSE_GOAL = 1; // long pauses per minute in the take
export const DRILL_PAUSE_S = 3; // a drill fails on a silence this long
export const MIN_DRILL_WORDS = { point: 5, fillers: 30, pauses: 25 } as const;

export type Goal =
  | { kind: "point"; point: string; status: "missed" | "partial" }
  | { kind: "number"; onSlide: string; said: string | null }
  | { kind: "fillers"; per100: number; words: string[] }
  | { kind: "pauses"; perMin: number }
  | { kind: "ready" };

/** The single most important thing to work on next, from the latest take. */
export function nextGoal(take: Take): Goal {
  const missed = take.points.find((p) => p.status === "missed") ?? take.points.find((p) => p.status === "partial");
  if (missed) return { kind: "point", point: missed.text, status: missed.status as "missed" | "partial" };
  const number = take.numberIssues[0];
  if (number) return { kind: "number", onSlide: number.onSlide, said: number.said };
  if (take.fillersPer100 != null && take.fillersPer100 > FILLER_GOAL) {
    return { kind: "fillers", per100: take.fillersPer100, words: take.fillerWords };
  }
  if (take.longPausesPerMin != null && take.longPausesPerMin > PAUSE_GOAL) return { kind: "pauses", perMin: take.longPausesPerMin };
  return { kind: "ready" };
}

/** Goals a short drill can check; the others need a full take. */
export const canDrill = (goal: Goal): goal is Extract<Goal, { kind: "point" | "fillers" | "pauses" }> =>
  goal.kind === "point" || goal.kind === "pauses" || (goal.kind === "fillers" && goal.words.length > 0);

export interface DrillWord {
  word: string;
  start: number;
  end: number;
}

export interface DrillResult {
  verdict: "pass" | "almost" | "fail" | "short";
  key: MessageKey;
  vars: Record<string, string | number>;
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Fillers in `text` from this speaker's own list (the fillers found in their take). */
export function countFillers(text: string, fillerWords: string[]): number {
  const words = tokens(text);
  const phrases = [...new Set(fillerWords.map((f) => tokens(f).join(" ")).filter(Boolean))].sort(
    (a, b) => b.split(" ").length - a.split(" ").length, // longer phrases first, so each word counts once
  );
  let count = 0;
  for (let i = 0; i < words.length; ) {
    const hit = phrases.find((p) => {
      const parts = p.split(" ");
      return parts.every((part, j) => words[i + j] === part);
    });
    if (hit) {
      count++;
      i += hit.split(" ").length;
    } else {
      i++;
    }
  }
  return count;
}

/** Checks a drill recording against its goal. */
export function checkDrill(goal: Extract<Goal, { kind: "point" | "fillers" | "pauses" }>, text: string, words: DrillWord[]): DrillResult {
  const n = tokens(text).length;
  if (n < MIN_DRILL_WORDS[goal.kind]) return { verdict: "short", key: "drillTooShort", vars: { n: MIN_DRILL_WORDS[goal.kind] } };

  if (goal.kind === "point") {
    const [check] = rulesCheck([goal.point], toSentences(text));
    if (check.status === "covered") return { verdict: "pass", key: "drillPointPass", vars: {} };
    if (check.status === "partial") return { verdict: "almost", key: "drillPointAlmost", vars: {} };
    return { verdict: "fail", key: "drillPointFail", vars: {} };
  }

  if (goal.kind === "fillers") {
    const count = countFillers(text, goal.words);
    const per100 = Math.round((count / n) * 1000) / 10;
    return per100 <= DRILL_FILLERS
      ? { verdict: "pass", key: "drillFillersPass", vars: { count, per100 } }
      : { verdict: "fail", key: "drillFillersFail", vars: { count, per100, limit: DRILL_FILLERS } };
  }

  const gaps = words.slice(1).map((w, i) => w.start - words[i].end);
  const longest = gaps.length ? Math.max(...gaps) : 0;
  return longest < DRILL_PAUSE_S
    ? { verdict: "pass", key: "drillPausesPass", vars: {} }
    : { verdict: "fail", key: "drillPausesFail", vars: { seconds: longest.toFixed(1), limit: DRILL_PAUSE_S } };
}
