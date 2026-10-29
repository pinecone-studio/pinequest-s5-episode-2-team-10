// Checks for the body-language summary (web/src/lib/bodySignals.ts) on made-up camera frames.
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_body_signals.ts
import assert from "node:assert/strict";
import { summarize, type FrameSignals } from "../web/src/lib/bodySignals.ts";

/** `seconds` of frames at 15 per second; `at(t)` sets what differs from a steady, well-framed speaker. */
function frames(seconds: number, at: (t: number) => Partial<FrameSignals> = () => ({})): FrameSignals[] {
  return Array.from({ length: Math.round(seconds * 15) }, (_, i) => {
    const t = i / 15;
    return {
      t,
      face: true,
      eyeContact: true,
      lookingDown: false,
      yaw: 0,
      pitch: 0,
      body: true,
      handsVisible: true,
      shoulderTilt: 1,
      center: 0.5,
      shoulderWidth: 0.3,
      leftWrist: { x: 0.4, y: 0.6 },
      rightWrist: { x: 0.6, y: 0.6 },
      ...at(t),
    };
  });
}

// A steady speaker looking at the camera: eye contact the whole time, no eye or framing tips.
const steady = summarize(frames(10));
assert.equal(steady.eyeContact, 1);
assert.equal(steady.lookingDown, 0);
assert.equal(steady.faceShare, 1);
assert.equal(steady.framing, "ok");
assert.ok(steady.seconds > 9.5 && steady.seconds <= 10, String(steady.seconds));
assert.equal(steady.timeline.length, 10); // one entry per second
assert.ok(!steady.tips.includes("eyeContact") && !steady.tips.includes("lookingDown") && !steady.tips.includes("noFace"));

// Reading notes half the time: looking down is measured and gets its tip.
const reading = summarize(frames(10, (t) => (t % 2 < 1 ? { eyeContact: false, lookingDown: true } : {})));
assert.ok(reading.lookingDown > 0.4 && reading.lookingDown < 0.6, String(reading.lookingDown));
assert.ok(reading.tips.includes("lookingDown"));
assert.ok(reading.tips.includes("eyeContact"));
assert.ok(reading.timeline.some((s) => s.eyes === "down"));

// No face most of the time: the summary says so instead of judging eye contact.
const away = summarize(frames(10, (t) => (t > 2 ? { face: false, eyeContact: false } : {})));
assert.ok(away.faceShare < 0.5);
assert.ok(away.tips.includes("noFace"));

// Too far from the camera (narrow shoulders): framing advice.
assert.equal(summarize(frames(6, () => ({ shoulderWidth: 0.1 }))).framing, "far");
assert.ok(summarize(frames(6, () => ({ shoulderWidth: 0.1 }))).tips.includes("far"));

// No frames: an empty summary, not a crash.
const empty = summarize([]);
assert.equal(empty.seconds, 0);
assert.deepEqual(empty.timeline, []);

console.log("body signal checks passed");
