import { NextResponse } from "next/server";
import { langOf, t } from "@/lib/i18n";
import {
  askClaude,
  askOllama,
  isProtoModel,
  LlmError,
  replySchema,
  rulesReply,
  type Improvement,
  type ModelReply,
} from "@/lib/server/llm";
import { cleanPoints, inSpeech, MAX_POINTS, rulesCheck, toSentences, verifyPoints, type MainPoints } from "@/lib/server/points";

const MAX_TEXT = 20_000;
const MAX_IDEA = 500;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;

type Reply = {
  summary: string;
  strengths: string[];
  // Most important first. `quote` is kept only when it is really in the speech.
  improvements: Improvement[];
  model: string;
  mainPoints: MainPoints | null;
  received: { text: boolean; audio: string | null; slide: string | null };
};

function clip(value: string, max: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function fileOf(value: FormDataEntryValue | null): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** `keyPoints` is a JSON array of strings; anything else counts as no points. */
function keyPointsOf(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || !value) return [];
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const lang = langOf(request);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError(t(lang, "badForm"), 400);
  }

  const text = clip(String(form.get("text") ?? ""), MAX_TEXT);
  const slideText = clip(String(form.get("slideText") ?? ""), MAX_TEXT);
  const idea = clip(String(form.get("idea") ?? ""), MAX_IDEA);
  const rawPoints = keyPointsOf(form.get("keyPoints"));
  if (!Array.isArray(rawPoints) || rawPoints.length > MAX_POINTS) return jsonError(t(lang, "badPoints"), 400);
  const keyPoints = cleanPoints(rawPoints);
  const audio = fileOf(form.get("audio"));
  const slide = fileOf(form.get("slide"));
  const slideImage = fileOf(form.get("slideImage"));
  const modelField = form.get("model") ?? "claude";
  if (!isProtoModel(modelField)) return jsonError(t(lang, "unknownModel"), 400);
  const model = modelField;

  if (!text && !slideText && !audio && !slide && !slideImage) {
    return jsonError(t(lang, "noInput"), 400);
  }
  for (const file of [audio, slide, slideImage]) {
    if (file && file.size > MAX_FILE) return jsonError(t(lang, "fileTooBig"), 413);
  }

  const received = {
    text: Boolean(text),
    audio: audio ? audio.name || "audio" : null,
    slide: slide?.name || (slideImage ? "current-slide.jpg" : null),
  };

  const sentences = toSentences(text);
  const checkPoints = keyPoints.length > 0 || Boolean(idea);
  const language = t(lang, "replyLanguage");
  const prompt = [
    "Prototype check. Use only the transcript and slide text below.",
    "Do not invent quotes. Do not judge emotion, confidence, intonation, or vocal quality.",
    "The audio file is stored speech; judge the transcript, not the voice.",
    `Audio: ${audio ? `${audio.name || "audio"} (${audio.type || "unknown"}, ${audio.size} bytes)` : "none"}.`,
    `Presentation file: ${slide ? `${slide.name || "slide"} (${slide.type || "unknown"}, ${slide.size} bytes)` : "none"}.`,
    "",
    "Speech, as numbered sentences (from speech recognition, so it may contain errors):",
    sentences.length ? sentences.map((s) => `[${s.id}] ${s.text}`).join("\n") : "(none)",
    "",
    "Slide text:",
    slideText || "(none)",
    "",
    ...(checkPoints
      ? [
          `The speaker's pitch idea: ${idea || "(not given)"}`,
          "The main points they wanted to get across:",
          keyPoints.length ? keyPoints.map((p, i) => `(${i}) ${p}`).join("\n") : "(none)",
          "",
          "For each main point, judge whether the speech made it. Judge meaning, not wording; one shared word is not enough.",
          "- status: covered (clearly made), partial (vague or incomplete), missed (not said or only implied).",
          "- evidence: the exact words from the speech that make the point, copied from one sentence or consecutive sentences; empty when missed. Every quote is checked against the speech.",
          "- note: one short sentence on what was missing, or empty.",
          "off_topic: only sentences that have nothing to do with this pitch at all (its problem, solution, team, customers or business).",
          "A sentence about the team, experience, customers or money is on topic even if it is not a main point. Most pitches have none or one.",
          "reason: why it is off topic, in your own words; do not repeat the sentence.",
          "idea_comment: how well the speech as a whole got the idea across.",
          "",
        ]
      : []),
    "What to return:",
    "- summary: 2-3 sentences on the most important things to change.",
    "- strengths: 1-3 specific things the speaker did well.",
    "- improvements: 3-5 things to improve, most important first. For each:",
    "  title: a short name for the problem; why: what in the speech shows it and why it matters to the audience;",
    "  action: one concrete thing to do next time; example: a sentence the speaker could say instead, keeping their meaning",
    "  and adding no new facts or numbers; quote: the exact words from the speech where the problem shows, or empty.",
    ...(checkPoints ? ["  Include main points that were missed or only partly made."] : []),
    "Look at structure (opening, problem, solution, ask), clarity, missing evidence or numbers, a missing call to action,",
    "off-topic parts, fillers and repetition. Do not judge the voice, confidence or emotion.",
    "",
    "Reply with JSON only:",
    JSON.stringify({
      summary: `2-3 sentences in ${language}`,
      strengths: ["specific strength"],
      improvements: [
        { title: "short", why: "what shows it and why it matters", action: "what to do", example: "a better sentence", quote: "exact words or empty" },
      ],
      ...(checkPoints
        ? {
            point_checks: [{ point: 0, status: "covered | partial | missed", evidence: "exact quote", note: "" }],
            off_topic: [{ sentence_id: 0, reason: "short" }],
            idea_comment: `1-2 sentences in ${language}`,
          }
        : {}),
    }),
    `Write all text in ${language}. Use only what the speech and slide text say; never invent quotes or numbers.`,
  ].join("\n");

  try {
    let reply: ModelReply;
    let mainPoints: MainPoints | null = null;
    if (model === "rules") {
      if (checkPoints) mainPoints = verifyPoints(rulesCheck(keyPoints, sentences), keyPoints, sentences, [], "", "words");
      reply = rulesReply(text, slideText, lang, mainPoints?.points ?? []);
    } else {
      if (model === "ollama") {
        reply = await askOllama(prompt, lang, replySchema(checkPoints));
      } else {
        let image: { mediaType: string; data: string } | null = null;
        if (slideImage && slideImage.type.startsWith("image/") && slideImage.size <= MAX_IMAGE) {
          image = {
            mediaType: slideImage.type === "image/png" ? "image/png" : "image/jpeg",
            data: Buffer.from(await slideImage.arrayBuffer()).toString("base64"),
          };
        }
        reply = await askClaude(prompt, image, lang);
      }
      if (checkPoints) {
        mainPoints = verifyPoints(
          reply.raw.point_checks, keyPoints, sentences, reply.raw.off_topic, reply.raw.idea_comment, "llm", idea,
        );
      }
    }

    // A quote the model made up is dropped; the advice itself stays.
    const improvements = reply.improvements.map((i) => (i.quote && !inSpeech(i.quote, sentences) ? { ...i, quote: "" } : i));
    const body: Reply = { summary: reply.summary, strengths: reply.strengths, improvements, model, mainPoints, received };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof LlmError) return jsonError(err.message, err.status);
    return jsonError(t(lang, "sendFail"), 500);
  }
}
