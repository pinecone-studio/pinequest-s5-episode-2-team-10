// Checks for the coach voice: ElevenLabs is the automatic choice, and the read-aloud says its own
// words in Mongolian whatever the page language (web/src/lib/server/tts.ts, web/src/lib/coachVoice.ts).
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_coach_voice.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const k of ["PITCH_TTS", "ELEVENLABS_API_KEY", "AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]) delete process.env[k];
// Settings also come from env files in the working folder and the one above it, so run from an
// empty temporary folder: only process.env counts.
const empty = path.join(mkdtempSync(path.join(tmpdir(), "saylo-tts-")), "web");
mkdirSync(empty);
process.chdir(empty);
const { ttsBackend } = await import("../web/src/lib/server/tts.ts");

process.env.ELEVENLABS_API_KEY = "k";
process.env.AZURE_SPEECH_KEY = "k";
process.env.AZURE_SPEECH_REGION = "r";
assert.equal(ttsBackend(), "elevenlabs"); // both set: ElevenLabs
delete process.env.ELEVENLABS_API_KEY;
assert.equal(ttsBackend(), "azure"); // only Azure set
process.env.PITCH_TTS = "azure";
process.env.ELEVENLABS_API_KEY = "k";
assert.equal(ttsBackend(), "azure"); // an explicit choice wins

const { feedbackSteps, SPEECH_LANG } = await import("../web/src/lib/coachVoice.ts");
assert.equal(SPEECH_LANG, "mn");
const steps = feedbackSteps(
  { summary: "Сайн.", strengths: [{ text: "Тод эхлэл" }], improvements: [{ title: "Асуудал", action: "Тодорхой хэл.", example: "Жишээ.", quote: "" }] },
  () => null,
);
const said = steps.map((s) => ("say" in s ? s.say : "")).join(" ");
assert.ok(said.includes("Сайн тал") && said.includes("Сайжруулах зүйлс"), said);
assert.ok(!/Strengths|Things to improve|Try saying/.test(said), said);

console.log("coach voice checks passed");
