// Checks for the admin Status tab's history of each part (web/src/lib/statusHistory.ts).
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_status_history.ts
import assert from "node:assert/strict";
import { MAX_CHANGES, recordChecks, span, type History } from "../web/src/lib/statusHistory.ts";

const t = (min: number) => new Date(Date.UTC(2026, 9, 29, 10, min)).toISOString();

let h: History = {};
h = recordChecks(h, [{ key: "voice", health: "ok" }, { key: "gemma", health: "checking" }], t(0));
assert.equal(h.voice.health, "ok");
assert.equal(h.voice.since, t(0));
assert.equal(h.voice.lastOkAt, t(0));
assert.equal(h.gemma, undefined); // "checking" isn't a result

// Still OK: same state, "since" stays, counts go up, no new change.
h = recordChecks(h, [{ key: "voice", health: "ok" }], t(1));
assert.equal(h.voice.since, t(0));
assert.equal(h.voice.checks, 2);
assert.equal(h.voice.changes.length, 1);

// Goes down: a change with the error, "since" moves, the last OK time stays.
h = recordChecks(h, [{ key: "voice", health: "down", error: "Not reachable." }], t(5));
assert.equal(h.voice.since, t(5));
assert.equal(h.voice.lastOkAt, t(1));
assert.equal(h.voice.lastError, "Not reachable.");
assert.equal(h.voice.lastErrorAt, t(5));
assert.equal(h.voice.problems, 1);
assert.deepEqual(h.voice.changes[0], { at: t(5), from: "ok", to: "down", error: "Not reachable." });

// Back up: the last error is kept, newest change first.
h = recordChecks(h, [{ key: "voice", health: "ok" }], t(9));
assert.equal(h.voice.lastError, "Not reachable.");
assert.deepEqual(h.voice.changes.map((c) => c.to), ["ok", "down", "ok"]);

// At most MAX_CHANGES changes are kept.
for (let i = 0; i < 30; i++) h = recordChecks(h, [{ key: "voice", health: i % 2 ? "ok" : "warn" }], t(10 + i));
assert.equal(h.voice.changes.length, MAX_CHANGES);

// Durations for "up for …".
assert.deepEqual(span(t(0), t(0)), { d: 0, h: 0, m: 0 });
assert.deepEqual(span("2026-10-27T08:00:00Z", "2026-10-29T10:05:00Z"), { d: 2, h: 2, m: 5 });
assert.equal(span(null, t(0)), null);
assert.equal(span(t(5), t(0)), null); // a start after the check: unknown

console.log("status history checks passed");
