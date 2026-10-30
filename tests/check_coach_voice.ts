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

// Abbreviations are spoken as Mongolian words, not spelled out.
const { forSpeech } = await import("../web/src/lib/server/tts.ts");
assert.equal(forSpeech("Хурд 165 WPM байна."), "Хурд минутад 165 үг байна.");
assert.equal(forSpeech("Таны WPM хэт өндөр."), "Таны минутад хэлэх үгийн тоо хэт өндөр.");
assert.equal(forSpeech("Pace: 140 wpm"), "Pace: минутад 140 үг");
assert.equal(forSpeech("120 үг/мин хурдтай"), "минутад 120 үг хурдтай");
assert.equal(forSpeech("(хамгийн их нь 0:14 орчим, 8 дБ)."), "(хамгийн их нь 0:14 орчим, 8 децибел).");
assert.equal(forSpeech("Сайн байна уу."), "Сайн байна уу."); // ordinary text is untouched
assert.equal(forSpeech("dBz болон wpmx"), "dBz болон wpmx"); // only whole abbreviations

// Long number lists are merged into ranges and read as "from … to …".
const { ablativeSuffix, compressNumberLists } = await import("../web/src/lib/server/tts.ts");
const missed = [1, ...Array.from({ length: 21 }, (_, i) => i + 3)].join(", ");
assert.equal(compressNumberLists(`${missed}-р слайд`), "1, 3–23-р слайд");
assert.equal(
  forSpeech(`${missed}-р слайдын агуулгыг яриандаа хэлээгүй.`),
  "1, 3-аас 23 хүртэлх слайдын агуулгыг яриандаа хэлээгүй.",
);
assert.equal(forSpeech("1, 3–23-р слайдын"), "1, 3-аас 23 хүртэлх слайдын"); // already a range (the backend now writes these)
assert.equal(forSpeech("1, 2, 3, 4 болон 9"), "1-ээс 4 хүртэл болон 9");
assert.equal(forSpeech("1, 3, 5-р слайд"), "1, 3, 5-р слайд"); // no run of three: unchanged
assert.equal(forSpeech("2,5 сая, 3,1 сая"), "2,5 сая, 3,1 сая"); // decimals are not lists
assert.deepEqual(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 40, 50, 100, 1000].map((n) => `${n}-${ablativeSuffix(n)}`),
  ["1-ээс", "2-оос", "3-аас", "4-өөс", "5-аас", "6-гаас", "7-гоос", "8-аас", "9-өөс", "10-аас", "20-иос", "40-өөс", "50-иас", "100-гаас", "1000-аас"],
);
console.log("speech wording checks passed");
