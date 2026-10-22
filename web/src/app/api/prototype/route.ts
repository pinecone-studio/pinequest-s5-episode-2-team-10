import { NextResponse } from "next/server";
import { langOf, t } from "@/lib/i18n";
import { askClaude, askOllama, isProtoModel, LlmError, rulesReply, type Point } from "@/lib/server/llm";
import { cleanPoints, MAX_POINTS, rulesCheck, toSentences, verifyPoints, type MainPoints } from "@/lib/server/points";

const MAX_TEXT = 20_000;
const MAX_IDEA = 500;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;

type Reply = {
  summary: string;
  points: Point[];
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
          "Also list sentences that serve neither the idea nor any main point as off_topic, and say in idea_comment how well the speech got the idea across.",
          "",
        ]
      : []),
    "Reply with JSON only:",
    JSON.stringify({
      summary: `2-3 sentences in ${language}`,
      points: [{ title: "short", detail: "one concrete note" }],
      ...(checkPoints
        ? {
            point_checks: [{ point: 0, status: "covered | partial | missed", evidence: "exact quote", note: "" }],
            off_topic: [{ sentence_id: 0, reason: "short" }],
            idea_comment: `1-2 sentences in ${language}`,
          }
        : {}),
    }),
    `At most 3 points. Each detail must stay within what the transcript or slide text actually says. Write all text in ${language}.`,
  ].join("\n");

  try {
    let reply: { summary: string; points: Point[]; raw?: Record<string, unknown> };
    if (model === "rules") {
      reply = rulesReply(text, slideText, lang);
    } else if (model === "ollama") {
      reply = await askOllama(prompt, lang);
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

    let mainPoints: MainPoints | null = null;
    if (checkPoints) {
      mainPoints =
        model === "rules"
          ? verifyPoints(rulesCheck(keyPoints, sentences), keyPoints, sentences, [], "", "words")
          : verifyPoints(
              reply.raw?.point_checks,
              keyPoints,
              sentences,
              reply.raw?.off_topic,
              reply.raw?.idea_comment,
              "llm",
            );
    }
    const body: Reply = { summary: reply.summary, points: reply.points, model, mainPoints, received };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof LlmError) return jsonError(err.message, err.status);
    return jsonError(t(lang, "sendFail"), 500);
  }
}
