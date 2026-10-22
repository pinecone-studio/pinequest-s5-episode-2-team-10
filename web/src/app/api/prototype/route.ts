import { NextResponse } from "next/server";
import { askClaude, askOllama, isProtoModel, LlmError, rulesReply, type Point } from "@/lib/server/llm";

const MAX_TEXT = 20_000;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;

type Reply = {
  summary: string;
  points: Point[];
  model: string;
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

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Илгээсэн өгөгдлийг уншиж чадсангүй.", 400);
  }

  const text = clip(String(form.get("text") ?? ""), MAX_TEXT);
  const slideText = clip(String(form.get("slideText") ?? ""), MAX_TEXT);
  const audio = fileOf(form.get("audio"));
  const slide = fileOf(form.get("slide"));
  const slideImage = fileOf(form.get("slideImage"));
  const modelField = form.get("model") ?? "claude";
  if (!isProtoModel(modelField)) return jsonError("Ийм загвар алга.", 400);
  const model = modelField;

  if (!text && !slideText && !audio && !slide && !slideImage) {
    return jsonError("Яриа, аудио, эсвэл слайд алга.", 400);
  }
  for (const file of [audio, slide, slideImage]) {
    if (file && file.size > MAX_FILE) return jsonError("Файл 12 MB-аас том байна.", 413);
  }

  const received = {
    text: Boolean(text),
    audio: audio ? audio.name || "audio" : null,
    slide: slide?.name || (slideImage ? "current-slide.jpg" : null),
  };

  const prompt = [
    "Prototype check. Use only the transcript and slide text below.",
    "Do not invent quotes. Do not judge emotion, confidence, intonation, or vocal quality.",
    "The audio file is stored speech; judge the transcript, not the voice.",
    `Audio: ${audio ? `${audio.name || "audio"} (${audio.type || "unknown"}, ${audio.size} bytes)` : "none"}.`,
    `Presentation file: ${slide ? `${slide.name || "slide"} (${slide.type || "unknown"}, ${slide.size} bytes)` : "none"}.`,
    "",
    "Saved speech:",
    text || "(none)",
    "",
    "Slide text:",
    slideText || "(none)",
    "",
    'Reply with JSON only: {"summary":"2-3 sentences in Mongolian","points":[{"title":"short","detail":"one concrete note"}]}',
    "At most 3 points. Each detail must stay within what the transcript or slide text actually says.",
  ].join("\n");

  try {
    let reply: { summary: string; points: Point[] };
    if (model === "rules") {
      reply = rulesReply(text, slideText);
    } else if (model === "ollama") {
      reply = await askOllama(prompt);
    } else {
      let image: { mediaType: string; data: string } | null = null;
      if (slideImage && slideImage.type.startsWith("image/") && slideImage.size <= MAX_IMAGE) {
        image = {
          mediaType: slideImage.type === "image/png" ? "image/png" : "image/jpeg",
          data: Buffer.from(await slideImage.arrayBuffer()).toString("base64"),
        };
      }
      reply = await askClaude(prompt, image);
    }
    const body: Reply = { ...reply, model, received };
    return NextResponse.json(body);
  } catch (err) {
    if (err instanceof LlmError) return jsonError(err.message, err.status);
    return jsonError("Загвар руу илгээж чадсангүй.", 500);
  }
}
