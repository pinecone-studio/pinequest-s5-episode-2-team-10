// Checks that model answers point to the speech by sentence number (web/src/lib/server/points.ts, llm.ts).
// Run from the repository root (web/ must have node_modules):
//   JITI_ALIAS="{\"@\":\"$(pwd)/web/src\"}" web/node_modules/.bin/jiti tests/check_sentence_quotes.ts
import assert from "node:assert/strict";
import { parseReply, replySchema } from "../web/src/lib/server/llm.ts";
import { sentenceText, toSentences, verifyPoints } from "../web/src/lib/server/points.ts";

const sentences = toSentences("Сайн байна уу. Бид агаарын мэдрэгч хийсэн. 120 сая төгрөг хэрэгтэй.");
assert.equal(sentences.length, 3);

// Sentence numbers -> the speech's own text, in order, at most two, invalid ones ignored.
assert.equal(sentenceText(1, sentences), "Бид агаарын мэдрэгч хийсэн.");
assert.equal(sentenceText([2, 1], sentences), "Бид агаарын мэдрэгч хийсэн. 120 сая төгрөг хэрэгтэй.");
assert.equal(sentenceText([0, 1, 2], sentences).split(".").length - 1, 2);
assert.equal(sentenceText([-1, 7, 1.5, "1"], sentences), "");
assert.equal(sentenceText(undefined, sentences), "");

// Main points: evidence by number is real speech, so it is verified; a made-up text quote is not.
const points = ["Агаарын мэдрэгч", "Хөрөнгө оруулалт", "Баг"];
const result = verifyPoints(
  [
    { point: 0, status: "covered", sentences: [1], note: "" },
    { point: 1, status: "partial", evidence: "бид 500 сая төгрөг авсан", note: "" }, // not in the speech
    { point: 2, status: "missed", sentences: [], note: "Баг дурдаагүй" },
  ],
  points,
  sentences,
  "",
  "llm",
);
assert.equal(result.points[0].evidence, "Бид агаарын мэдрэгч хийсэн.");
assert.equal(result.points[0].verified, true);
assert.equal(result.points[1].verified, false);
assert.equal(result.points[1].evidence, "");
assert.equal(result.points[2].verified, true);
assert.equal(result.points[2].evidence, "");

// The reply keeps sentence numbers for the route; -1 means none.
const reply = parseReply({
  summary: "Тодорхой.",
  strengths: [{ text: "Сайн эхлэл", sentence: 0 }],
  improvements: [
    { title: "Асуудлаа хэл", why: "Тодорхойгүй.", action: "Асуудлаар эхэл.", example: "", sentence: -1 },
    { title: "Тоо", why: "Эх сурвалжгүй.", action: "Эх сурвалж хэл.", example: "", sentence: 2 },
  ],
});
assert.ok(reply);
assert.equal(reply.strengths[0].sentence, 0);
assert.equal(reply.improvements[0].sentence, undefined);
assert.equal(reply.improvements[1].sentence, 2);

// The schema Ollama is held to asks for numbers, not copied quotes.
const schema = JSON.stringify(replySchema(true, false));
assert.ok(!schema.includes('"quote"') && !schema.includes('"evidence"'), schema);
assert.ok(schema.includes('"sentence"') && schema.includes('"sentences"'));

console.log("sentence quote checks passed");
