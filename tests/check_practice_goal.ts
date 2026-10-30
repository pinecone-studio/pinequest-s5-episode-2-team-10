// Checks for the next-take goal and drills (web/src/lib/practiceGoal.ts).
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_practice_goal.ts
import assert from "node:assert/strict";
import { canDrill, checkDrill, countFillers, nextGoal } from "../web/src/lib/practiceGoal.ts";
import type { Take } from "../web/src/lib/takes.ts";

const base: Take = {
  id: "t", createdAt: "2026-10-28T10:00:00Z", audio: null, points: [], covered: 0, total: 0,
  fillersPer100: 1, wpm: 130, longPausesPerMin: 0.2, endVolumeDropDb: 2, numberIssues: [], fillerWords: ["аан", "ээ"], delivery: [],
};
const take = (over: Partial<Take>): Take => ({ ...base, ...over });

// Goal order: a missed point, then a partial one, then numbers, fillers, pauses; else ready.
const points = [
  { text: "120 сая төгрөгийн хөрөнгө оруулалт хэрэгтэй", status: "partial" as const },
  { text: "Мэдрэгч агаарын чанарыг хэмжинэ", status: "missed" as const },
];
const busy = take({ points, numberIssues: [{ onSlide: "40%", said: "30 хувь" }], fillersPer100: 6, longPausesPerMin: 3 });
assert.deepEqual(nextGoal(busy), { kind: "point", point: "Мэдрэгч агаарын чанарыг хэмжинэ", status: "missed" });
assert.equal(nextGoal(take({ ...busy, points: [points[0]] })).kind, "point");
assert.equal((nextGoal(take({ ...busy, points: [points[0]] })) as { status: string }).status, "partial");
assert.equal(nextGoal(take({ ...busy, points: [] })).kind, "number");
assert.equal(nextGoal(take({ ...busy, points: [], numberIssues: [] })).kind, "fillers");
assert.equal(nextGoal(take({ ...busy, points: [], numberIssues: [], fillersPer100: 2 })).kind, "pauses");
assert.equal(nextGoal(take({})).kind, "ready");
assert.equal(nextGoal(take({ fillersPer100: null, longPausesPerMin: null })).kind, "ready");

// When points, numbers, fillers and pauses are fine, the goal is what the analysis said to fix:
// a measured delivery problem first, then its other fixes. "Ready" only when nothing is left.
const fixes = [{ problem: "Шийдлийн талаарх мэдээлэл хэт ерөнхий байна.", action: "Апп хэрхэн ажилладгийг нэг жишээгээр хэл." }];
assert.deepEqual(nextGoal(take({ fixes })), { kind: "fix", problem: fixes[0].problem, action: fixes[0].action });
const rushed = { problem: "Төгсгөлдөө яарсан.", action: "Сүүлийн хэсгийг удаан хэл." };
assert.equal((nextGoal(take({ fixes, delivery: [rushed] })) as { problem: string }).problem, rushed.problem);
assert.equal(nextGoal(take({ fixes, fillersPer100: 6 })).kind, "fillers"); // the fixed checks still come first
assert.equal(nextGoal(take({ fixes: [] })).kind, "ready");
assert.equal(canDrill(nextGoal(take({ fixes }))), false); // a whole-take fix: no short drill
assert.deepEqual(workOn(take({ fixes })).map((f) => f.kind), ["fix"]);

// Which goals a drill can check.
assert.equal(canDrill(nextGoal(busy)), true);
assert.equal(canDrill({ kind: "number", onSlide: "40%", said: null }), false);
assert.equal(canDrill({ kind: "fillers", per100: 6, words: [] }), false); // no list: a drill would always pass
assert.equal(canDrill({ kind: "ready" }), false);

// Fillers: the speaker's own list, phrases counted once, whole words only.
assert.equal(countFillers("аан бид ээ нөгөө аан тэгээд тэгээд", ["аан", "ээ", "тэгээд тэгээд"]), 4); // "тэгээд тэгээд" once
assert.equal(countFillers("Аан, бид шинэ аппыг хийсэн.", ["аан"]), 1);
assert.equal(countFillers("аанхай", ["аан"]), 0);

// Point drill: the key words decide.
const pointGoal = { kind: "point" as const, point: "Мэдрэгч агаарын чанарыг хэмжинэ", status: "missed" as const };
assert.equal(checkDrill(pointGoal, "Манай мэдрэгч өрөөний агаарын чанарыг байнга хэмжинэ.", []).verdict, "pass");
assert.equal(checkDrill(pointGoal, "Бид хүүхдүүдэд зориулсан шинэ апп хийсэн юм.", []).verdict, "fail");
assert.equal(checkDrill(pointGoal, "Сайн байна уу", []).verdict, "short");

// Fillers drill: pass at or under 2 per 100 words.
const fillerGoal = { kind: "fillers" as const, per100: 6, words: ["аан", "ээ"] };
const clean = Array.from({ length: 60 }, () => "үг").join(" "); // + 1 filler = 1.6 per 100
assert.equal(checkDrill(fillerGoal, `${clean} аан`, []).verdict, "pass");
const messy = checkDrill(fillerGoal, `${clean} аан ээ аан ээ`, []);
assert.equal(messy.verdict, "fail");
assert.equal(messy.vars.count, 4);

// Pauses drill: fail on a silence of 3 s or more.
const pausesGoal = { kind: "pauses" as const, perMin: 3 };
const steady = Array.from({ length: 30 }, (_, i) => ({ word: "үг", start: i * 0.6, end: i * 0.6 + 0.5 }));
const text = steady.map((w) => w.word).join(" ");
assert.equal(checkDrill(pausesGoal, text, steady).verdict, "pass");
const gap = steady.map((w, i) => (i >= 15 ? { ...w, start: w.start + 4, end: w.end + 4 } : w));
const paused = checkDrill(pausesGoal, text, gap);
assert.equal(paused.verdict, "fail");
assert.equal(paused.vars.seconds, "4.1");

console.log("practice goal checks passed");

// "Work on" for one take: missed points first, then partial, numbers, delivery, fillers.
import { workOn } from "../web/src/lib/practiceGoal.ts";
const busyTake = take({
  points: [
    { text: "Хөрөнгө оруулалт", status: "partial" },
    { text: "Асуудал", status: "missed" },
    { text: "Шийдэл", status: "covered" },
  ],
  numberIssues: [{ onSlide: "40%", said: "30 хувь" }],
  delivery: [{ problem: "Төгсгөлдөө яарсан", action: "Удаан хэл." }],
  fillersPer100: 6,
  longPausesPerMin: 3,
});
assert.deepEqual(workOn(busyTake).map((f) => f.kind), ["point", "point", "number", "delivery", "fillers"]);
assert.equal(workOn(busyTake)[0].vars.point, "Асуудал"); // missed before partial
assert.equal(workOn(busyTake)[3].hint, "Удаан хэл.");
// The general long-pause rule only applies when the delivery checks didn't run.
assert.deepEqual(workOn(take({ longPausesPerMin: 3 })).map((f) => f.kind), ["pauses"]);
assert.deepEqual(workOn(take({})), []);

console.log("work-on checks passed");
