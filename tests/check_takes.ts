// Checks for comparing a pitch's takes (web/src/lib/takes.ts).
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_takes.ts
import assert from "node:assert/strict";
import { cellTrend, compareTakes, MAX_TAKES, orderTakes, takeFrom, type Take } from "../web/src/lib/takes.ts";
import type { Attempt, Report } from "../web/src/lib/types.ts";

function take(over: Partial<Take> & { id: string }): Take {
  return {
    createdAt: `2026-10-2${over.id.length}T10:00:00Z`,
    audio: null,
    points: [],
    covered: 0,
    total: 0,
    fillersPer100: 4,
    wpm: 130,
    longPausesPerMin: 1,
    endVolumeDropDb: 3,
    numberIssues: [],
    fillerWords: [],
    delivery: [],
    ...over,
  };
}
const pts = (...s: Take["points"][number]["status"][]) =>
  s.map((status, i) => ({ text: ["Problem", "Solution", "Proof", "The ask"][i], status }));

// From a saved report: an unverified point counts as missed; the recording is name + length.
const attempt = { id: "a1", created_at: "2026-10-27T09:00:00Z", audio_filename: "Бичлэг.webm", duration_s: 61.234 } as Attempt;
const report = {
  metrics: { duration_s: 61, wpm: 128.4, fillers_per_100: 3.2, long_pauses_per_min: 0.5, pitch_range_st: 5, end_volume_drop_db: 2.1 },
  feedback: {
    main_points: {
      points: [
        { point: 0, text: "Problem", status: "covered", verified: true, evidence: "", note: "" },
        { point: 1, text: "Proof", status: "covered", verified: false, evidence: "", note: "" },
      ],
    },
  },
} as unknown as Report;
const t1 = takeFrom(attempt, report);
assert.deepEqual(t1.points.map((p) => p.status), ["covered", "missed"]);
assert.equal(t1.covered, 1);
assert.equal(t1.total, 2);
assert.equal(t1.audio, "Бичлэг.webm|61.23");
assert.equal(t1.fillersPer100, 3.2);

// Order: oldest first; the same recording analysed twice is one take (the latest);
// different recordings with the same name stay separate; at most MAX_TAKES.
const ordered = orderTakes([
  take({ id: "c", createdAt: "2026-10-27T12:00:00Z", audio: "Бичлэг.webm|40.00" }),
  take({ id: "a", createdAt: "2026-10-27T10:00:00Z", audio: "Бичлэг.webm|61.23" }),
  take({ id: "b", createdAt: "2026-10-27T11:00:00Z", audio: "Бичлэг.webm|61.23" }),
]);
assert.deepEqual(ordered.map((t) => t.id), ["b", "c"]);
const many = Array.from({ length: 8 }, (_, i) => take({ id: `t${i}`, createdAt: `2026-10-27T1${i}:00:00Z` }));
assert.equal(orderTakes(many).length, MAX_TAKES);
assert.equal(orderTakes(many).at(-1)?.id, "t7");

// Main points come first: newly missed, then still missed, then newly covered.
const before = take({ id: "p", points: pts("missed", "covered", "missed", "partial"), covered: 1, total: 4 });
const after = take({ id: "pp", points: pts("covered", "missed", "missed", "covered"), covered: 2, total: 4, fillersPer100: 2 });
const changes = compareTakes(before, after);
assert.deepEqual(
  changes.map((c) => [c.key, c.vars.point ?? ""]),
  [
    ["takeNowMissed", "Solution"],
    ["takeStillMissed", "Proof"],
    ["takeNowCovered", "Problem"],
    ["takeNowCovered", "The ask"],
    ["takeFillers", ""],
  ],
);
assert.equal(changes.at(-1)?.trend, "better");

// Points are matched by text, so reordering or a changed case/spacing doesn't break it.
const reordered = take({ id: "r", points: [{ text: "the  ask", status: "covered" }, { text: "Problem", status: "missed" }] });
assert.deepEqual(
  compareTakes(take({ id: "q", points: pts("covered", "missed", "missed", "missed") }), reordered).map((c) => c.key),
  ["takeNowMissed", "takeNowCovered"],
);

// Small differences are noise; pace changes are reported without a verdict.
const quiet = compareTakes(take({ id: "x", fillersPer100: 4 }), take({ id: "y", fillersPer100: 4.3, wpm: 135, longPausesPerMin: 1.2, endVolumeDropDb: 4 }));
assert.deepEqual(quiet, []);
const pace = compareTakes(take({ id: "x", wpm: 150 }), take({ id: "y", wpm: 128 }));
assert.deepEqual(pace.map((c) => [c.key, c.trend]), [["takePace", "info"]]);

// Table cells: lower fillers is better; more points covered is better; missing values give no trend.
const a = take({ id: "a", covered: 2, total: 4, fillersPer100: 5 });
const b = take({ id: "bb", covered: 3, total: 4, fillersPer100: 6 });
assert.equal(cellTrend("points", a, b), "better");
assert.equal(cellTrend("fillers", a, b), "worse");
assert.equal(cellTrend("fillers", undefined, b), null);
assert.equal(cellTrend("volume", take({ id: "a", endVolumeDropDb: null }), b), null);

console.log("take checks passed");
