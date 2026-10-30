// MediaPipe's "INFO: ..." lines go to console.info, real errors stay on console.error.
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_mediapipe_logs.ts
import assert from "node:assert/strict";

const seen: { error: unknown[][]; info: unknown[][] } = { error: [], info: [] };
console.error = (...args: unknown[]) => void seen.error.push(args);
console.info = (...args: unknown[]) => void seen.info.push(args);
const { quietMediaPipeInfo, isMediaPipeInfo } = await import("../web/src/lib/mediapipeLogs.ts");

assert.ok(isMediaPipeInfo("INFO: Created TensorFlow Lite XNNPACK delegate for CPU."));
assert.ok(isMediaPipeInfo("I0000 00:00:1730000000.000000 1 gl_context.cc:357] GL version: 3.0"));
assert.ok(!isMediaPipeInfo("Error: model failed to load"));
assert.ok(!isMediaPipeInfo({ message: "INFO: not a string" }));

quietMediaPipeInfo();
quietMediaPipeInfo(); // twice is fine
console.error("INFO: Created TensorFlow Lite XNNPACK delegate for CPU.");
console.error("Real failure", 42);
assert.equal(seen.info.length, 1);
assert.deepEqual(seen.error, [["Real failure", 42]]);
process.stdout.write("mediapipe log checks passed\n");
