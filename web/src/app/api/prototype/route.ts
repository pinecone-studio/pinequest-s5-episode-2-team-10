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
  type Strength,
} from "@/lib/server/llm";
import { measureSpeech, numberCandidates, numberMismatches, numberValue } from "@/lib/server/measure";
import { parsePartialJson } from "@/lib/server/partialJson";
import {
  cleanPoints,
  cleanQuote,
  inSpeech,
  MAX_POINTS,
  rulesCheck,
  toSentences,
  verifyOffTopic,
  verifyPoints,
  type MainPoints,
  type OffTopic,
} from "@/lib/server/points";

const MAX_TEXT = 20_000;
const MAX_IDEA = 500;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;
const NDJSON = "application/x-ndjson";
const STREAM_EVERY_MS = 200;

type Reply = {
  summary: string;
  strengths: Strength[];
  // Measured findings first (from code), then the model's advice, most important first.
  // A model quote is kept only when it is really in the speech.
  improvements: Improvement[];
  offTopic: OffTopic[];
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
  // Measured by code for every model, shown first and given to the model so it doesn't repeat them.
  const measured = [...measureSpeech(text, lang), ...numberMismatches(slideText, text, lang)];
  const numbers = numberCandidates(slideText, sentences);
  const prompt = [
    "You coach a speaker on one practice pitch. Judge the SPEECH: what the speaker said and how they said it in words.",
    "The slide text is only there to check that the speech agrees with the slides. Do not review the slides,",
    "and never praise or criticise something that only appears on the slides.",
    "Do not judge emotion, confidence, intonation or vocal quality. The speech comes from speech recognition and may contain errors.",
    "",
    "Speech, as numbered sentences:",
    sentences.length ? sentences.map((s) => `[${s.id}] ${s.text}`).join("\n") : "(none)",
    "",
    "Slide text:",
    slideText || "(none)",
    "",
    ...(measured.length
      ? [
          "Already measured by code and shown to the speaker; do not repeat these as improvements:",
          ...measured.map((m) => `- ${m.title}: ${m.why}`),
          "",
        ]
      : []),
    ...(checkPoints
      ? [
          `The speaker's pitch idea: ${idea || "(not given)"}`,
          "The main points they wanted to get across:",
          keyPoints.length ? keyPoints.map((p, i) => `(${i}) ${p}`).join("\n") : "(none)",
          "",
          "point_checks: for each main point, judge whether the speech made it. Judge meaning, not wording; one shared word is not enough.",
          "- point: the number in brackets before that main point. One entry per main point, in the same order.",
          "- status: covered (clearly made), partial (vague or incomplete), missed (not said or only implied).",
          "- evidence: the exact words from the speech that make the point; empty when missed.",
          "- note: one short sentence on what was missing, or empty.",
          "idea_comment: how well the speech as a whole got the idea across.",
          "",
        ]
      : []),
    ...(numbers.length
      ? [
          `number_checks: these numbers are on the slides but not in the speech as written: ${numbers.join(", ")}.`,
          "For each, give on_slide (the number), said (the exact words from the speech where the speaker gave this figure,",
          "even in words, or null if they never gave it) and inconsistent (true only when the speaker gave a different value).",
          "",
        ]
      : []),
    "What to return:",
    "- summary: 2-3 sentences on the most important things to change in the speech.",
    "- strengths: 1-3 things the speaker did well, each with quote: the exact words from the speech that show it.",
    "- improvements: 2-4 things to improve in what was said, most important first. Look at the opening, a clear problem,",
    "  the solution, proof (facts, numbers), a clear ask or next step at the end, off-topic parts, and numbers that",
    "  disagree with the slides. For each: title; why (what in the speech shows it and why it matters to the audience);",
    "  action (one concrete thing to do); example (a sentence to say instead, keeping the meaning and adding no new facts",
    "  or numbers); quote (the exact words from the speech where it shows, or empty).",
    ...(checkPoints ? ["  Include main points that were missed or only partly made."] : []),
    "- off_topic: sentences that have nothing to do with this pitch (its problem, solution, team, customers or business),",
    "  such as personal stories that don't support the pitch. Give sentence_id and reason (in your own words; do not",
    "  repeat the sentence). Empty when everything is on topic.",
    "",
    "Reply with JSON only:",
    JSON.stringify({
      summary: `2-3 sentences in ${language}`,
      strengths: [{ text: "specific strength", quote: "exact words" }],
      improvements: [
        { title: "short", why: "what shows it and why it matters", action: "what to do", example: "a better sentence", quote: "exact words or empty" },
      ],
      off_topic: [{ sentence_id: 0, reason: "short" }],
      ...(numbers.length ? { number_checks: [{ on_slide: numbers[0], said: "exact words or null", inconsistent: false }] } : {}),
      ...(checkPoints
        ? {
            point_checks: [{ point: 0, status: "covered | partial | missed", evidence: "exact quote", note: "" }],
            idea_comment: `1-2 sentences in ${language}`,
          }
        : {}),
    }),
    `Write all text in ${language}, except quotes: copy "quote", "evidence" and "said" word for word from the speech,`,
    "in the speech's own language, never translated. Use only what the speech and slide text say; never invent quotes or numbers.",
  ].join("\n");

  /** Number mismatches the model found, kept only when its quote of what was said is in the speech. */
  function numberFindings(raw: unknown): Improvement[] {
    const out: Improvement[] = [];
    for (const item of Array.isArray(raw) ? raw : []) {
      if (!item || typeof item !== "object") continue;
      const n = item as Record<string, unknown>;
      // Models often add the unit ("0.96 AUC"); compare the numeric value with the candidates.
      const value = numberValue(typeof n.on_slide === "string" ? n.on_slide : String(n.on_slide ?? ""));
      const onSlide = numbers.find((c) => numberValue(c) === value);
      const said = cleanQuote(n.said);
      if (n.inconsistent !== true || !onSlide || !said || !inSpeech(said, sentences)) continue;
      out.push({
        source: "measured",
        title: t(lang, "numberTitle"),
        why: t(lang, "numberWhy", { slide: onSlide }),
        action: t(lang, "numberAction"),
        example: "",
        quote: said,
      });
    }
    const known = new Set(measured.filter((m) => m.title === t(lang, "numberTitle")).map((m) => numberValue(m.why)));
    return out.filter((f) => !known.has(numberValue(f.why))).slice(0, 3);
  }

  /** Runs the chosen model and checks its answer. `onPartial` gets progress while Ollama writes. */
  async function analyze(onPartial?: (partial: Partial<Reply>) => void): Promise<Reply> {
    let reply: ModelReply;
    let mainPoints: MainPoints | null = null;
    let offTopic: OffTopic[] = [];
    let numberIssues: Improvement[] = [];
    // The measured findings are known before the model starts; show them straight away.
    onPartial?.({ improvements: measured });
    if (model === "rules") {
      if (checkPoints) mainPoints = verifyPoints(rulesCheck(keyPoints, sentences), keyPoints, sentences, "", "words");
      reply = rulesReply(text, slideText, lang, mainPoints?.points ?? []);
    } else {
      if (model === "ollama" || model === "ollama-think") {
        const onText = onPartial
          ? throttle((soFar: string) => {
              const partial = partialReply(soFar);
              onPartial({ ...partial, improvements: [...measured, ...(partial.improvements ?? [])] });
            }, STREAM_EVERY_MS)
          : undefined;
        reply = await askOllama(prompt, lang, replySchema(checkPoints, numbers.length > 0), onText, model === "ollama-think");
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
        mainPoints = verifyPoints(reply.raw.point_checks, keyPoints, sentences, reply.raw.idea_comment, "llm");
      }
      offTopic = verifyOffTopic(reply.raw.off_topic, sentences, idea, keyPoints);
      numberIssues = numberFindings(reply.raw.number_checks);
    }

    // A quote the model made up is dropped; the advice itself stays. A strength must quote the speech.
    const quoted = (q: string) => {
      const c = cleanQuote(q);
      return c && inSpeech(c, sentences) ? c : "";
    };
    // Small models repeat measured number mismatches despite the prompt; drop advice about a figure already flagged.
    const flaggedFigures = [...measured, ...numberIssues]
      .filter((m) => m.title === t(lang, "numberTitle"))
      .map((m) => numberValue(m.why))
      .filter(Boolean);
    const modelAdvice = reply.improvements
      .filter((i) => i.source !== "model" || !flaggedFigures.some((v) => `${i.title} ${i.why}`.includes(v)))
      .map((i) => ({ ...i, quote: i.source === "model" ? quoted(i.quote) : i.quote }));
    const strengths = reply.strengths
      .map((st) => ({ ...st, quote: quoted(st.quote) }))
      .filter((st) => st.quote);
    return {
      summary: reply.summary,
      strengths,
      improvements: [...measured, ...numberIssues, ...modelAdvice],
      offTopic,
      model,
      mainPoints,
      received,
    };
  }

  const failure = (err: unknown) =>
    err instanceof LlmError ? { message: err.message, status: err.status } : { message: t(lang, "sendFail"), status: 500 };

  // Streaming: one JSON object per line. {"type":"partial",...} while the model writes (not checked yet),
  // then {"type":"done",...} with the checked reply, or {"type":"error","error":"..."}.
  if (request.headers.get("accept")?.includes(NDJSON)) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        // A throttled progress update may fire after the final line; ignore it then.
        const send = (line: object) => {
          if (!closed) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        };
        try {
          const body = await analyze((partial) => send({ type: "partial", ...partial }));
          send({ type: "done", ...body });
        } catch (err) {
          send({ type: "error", error: failure(err).message });
        } finally {
          closed = true;
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { "content-type": NDJSON, "cache-control": "no-store" } });
  }

  try {
    return NextResponse.json(await analyze());
  } catch (err) {
    const { message, status } = failure(err);
    return jsonError(message, status);
  }
}

/** What the model has written so far, in the reply's shape. Unchecked; only for showing progress. */
function partialReply(soFar: string): Partial<Reply> {
  const raw = parsePartialJson(soFar);
  if (!raw || typeof raw !== "object") return {};
  const body = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    summary: str(body.summary),
    strengths: (Array.isArray(body.strengths) ? body.strengths : [])
      .map((v) => (typeof v === "string" ? { text: v, quote: "" } : { text: str(v?.text), quote: "" }))
      .filter((v) => v.text),
    improvements: (Array.isArray(body.improvements) ? body.improvements : [])
      .filter((i): i is Record<string, unknown> => Boolean(i) && typeof i === "object" && Boolean(str(i.title)))
      .map((i) => ({ source: "model" as const, title: str(i.title), why: str(i.why), action: str(i.action), example: str(i.example), quote: "" })),
  };
}

/** Calls `fn` at most every `ms`, always with the latest value; the last call is never dropped. */
function throttle<T>(fn: (value: T) => void, ms: number): (value: T) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T;
  return (value: T) => {
    pending = value;
    const wait = last + ms - Date.now();
    if (wait <= 0) {
      last = Date.now();
      fn(value);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(pending);
      }, wait);
    }
  };
}
