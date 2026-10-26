// Checks for the delivery rules (web/src/lib/server/delivery.ts) on made-up word timings.
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_delivery.ts
import assert from "node:assert/strict";
import { clock, measureDelivery, parseTimedWords, type TimedWord } from "../web/src/lib/server/delivery.ts";

/** `n` words evenly over [from, to), every word at loudness `db`. */
function speech(n: number, from: number, to: number, db = -20, word = "үг"): TimedWord[] {
  const step = (to - from) / n;
  return Array.from({ length: n }, (_, i) => ({ word, start: from + i * step, end: from + (i + 0.8) * step, db }));
}
const titles = (ws: TimedWord[]) => measureDelivery(ws, "en").findings.map((f) => f.title);

// Steady 120 words/min for 2 minutes: nothing to report.
const steady = speech(240, 0, 120);
assert.deepEqual(titles(steady), []);
assert.equal(measureDelivery(steady, "en").facts.wpm, 120);

// Too few words: nothing at all, not even a pace.
assert.equal(measureDelivery(speech(20, 0, 10), "en").facts.wpm, null);

// The last 30 s at 200 words/min after 90 s at 120.
const endRush = [...speech(180, 0, 90), ...speech(100, 90, 120)];
assert.ok(titles(endRush).includes("Speeding up at the end"), "end rush");
assert.ok(!titles(endRush).includes("A rushed stretch"), "end rush is not reported twice");

// A fast stretch in the middle.
const midRush = [...speech(80, 0, 40), ...speech(100, 40, 70), ...speech(100, 70, 120)];
assert.ok(titles(midRush).includes("A rushed stretch"), "mid rush");

// A 4 s silence in the middle.
const paused = [...speech(100, 0, 50), ...speech(100, 54, 104)];
const pause = measureDelivery(paused, "en");
assert.equal(pause.facts.longPauses, 1);
const pauseFinding = pause.findings.find((f) => f.title === "Long pauses");
assert.ok(pauseFinding?.why.includes("0:50"), pauseFinding?.why);

// Five fillers within a few seconds.
const fillers = speech(120, 0, 60);
for (const i of [40, 42, 44, 46, 48]) fillers[i] = { ...fillers[i], word: "аан" };
assert.ok(titles(fillers).includes("Bursts of filler words"), "filler burst");
// The same five fillers spread out: no burst.
const spread = speech(120, 0, 60);
for (const i of [5, 30, 55, 80, 105]) spread[i] = { ...spread[i], word: "аан" };
assert.ok(!titles(spread).includes("Bursts of filler words"), "spread fillers");

// Sentences (split by 1 s pauses) whose last two words are 10 dB quieter.
const fading: TimedWord[] = [];
for (let s = 0; s < 6; s++) {
  const sentence = speech(8, s * 5, s * 5 + 4);
  sentence[6].db = -30;
  sentence[7].db = -30;
  fading.push(...sentence);
}
const fade = measureDelivery(fading, "en");
assert.equal(fade.facts.trailingSentences, 6);
assert.ok(fade.findings.some((f) => f.title === "Your voice fades at the ends of sentences"));
// Without loudness, the check is skipped instead of guessing.
assert.ok(!titles(fading.map(({ db: _db, ...w }) => w)).includes("Your voice fades at the ends of sentences"));

// Every finding quotes words that are in the speech, so the page can play the moment back.
for (const ws of [endRush, midRush, paused, fillers, fading]) {
  const said = ws.map((w) => w.word).join(" ");
  for (const f of measureDelivery(ws, "en").findings) {
    assert.ok(f.quote && said.includes(f.quote.replace(/ …$/, "")), `${f.title}: ${f.quote}`);
  }
}

// Input checks.
assert.deepEqual(parseTimedWords(null), []);
assert.equal(parseTimedWords("not json"), null);
assert.equal(parseTimedWords(JSON.stringify([{ word: "a", start: "1", end: 2 }])), null);
assert.equal(parseTimedWords(JSON.stringify(Array(3001).fill({ word: "a", start: 0, end: 1 }))), null);
assert.deepEqual(parseTimedWords(JSON.stringify([{ word: "b", start: 2, end: 1, db: 5 }, { word: "a", start: 0, end: 1, db: -20 }])), [
  { word: "a", start: 0, end: 1, db: -20 },
  { word: "b", start: 2, end: 2 }, // end before start is clamped; a positive dB is dropped
]);
assert.equal(clock(65.4), "1:05");

console.log("delivery checks passed");
