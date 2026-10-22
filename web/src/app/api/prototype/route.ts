import { readFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

const MAX_TEXT = 20_000;
const MAX_FILE = 12 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;

type Point = { title: string; detail: string };

type Reply = {
  summary: string;
  points: Point[];
  received: { text: boolean; audio: string | null; slide: string | null };
};

function clip(value: string, max: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function fileOf(value: FormDataEntryValue | null): File | null {
  return value instanceof File && value.size > 0 ? value : null;
}

function parseReply(raw: unknown): { summary: string; points: Point[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.summary !== "string" || !body.summary.trim()) return null;
  if (!Array.isArray(body.points)) return null;
  const points: Point[] = [];
  for (const item of body.points.slice(0, 3)) {
    if (!item || typeof item !== "object") return null;
    const point = item as Record<string, unknown>;
    if (typeof point.title !== "string" || typeof point.detail !== "string") return null;
    const title = point.title.trim().slice(0, 120);
    const detail = point.detail.trim().slice(0, 500);
    if (!title || !detail) return null;
    points.push({ title, detail });
  }
  return { summary: body.summary.trim().slice(0, 800), points };
}

function apiKey() {
  const fromEnv = process.env.ANTHROPIC_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const files = [path.join(process.cwd(), ".env.local"), path.join(process.cwd(), ".env"), path.join(process.cwd(), "..", ".env")];
  for (const file of files) {
    try {
      const line = readFileSync(file, "utf8")
        .split("\n")
        .find((row) => row.startsWith("ANTHROPIC_API_KEY="));
      const value = line?.slice("ANTHROPIC_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      /* This env file is not present. */
    }
  }
  return "";
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

  if (!text && !slideText && !audio && !slide && !slideImage) {
    return jsonError("Яриа, аудио, эсвэл слайд алга.", 400);
  }
  for (const file of [audio, slide, slideImage]) {
    if (file && file.size > MAX_FILE) return jsonError("Файл 12 MB-аас том байна.", 413);
  }

  const key = apiKey();
  if (!key) return jsonError("Сервер дээр ANTHROPIC_API_KEY алга.", 503);

  const received = {
    text: Boolean(text),
    audio: audio ? audio.name || "audio" : null,
    slide: slide?.name || (slideImage ? "current-slide.jpg" : null),
  };

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text: [
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
      ].join("\n"),
    },
  ];

  if (slideImage && slideImage.type.startsWith("image/") && slideImage.size <= MAX_IMAGE) {
    const bytes = Buffer.from(await slideImage.arrayBuffer());
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: slideImage.type === "image/png" ? "image/png" : "image/jpeg",
        data: bytes.toString("base64"),
      },
    });
  }

  const model = process.env.PITCH_CLAUDE_MODEL?.trim() || "claude-opus-5-5";
  let response: Response;
  try {
    response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(50_000),
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 800,
        messages: [{ role: "user", content }],
      }),
    });
  } catch {
    return jsonError("LLM рүү хүрч чадсангүй.", 502);
  }

  if (!response.ok) return jsonError(`LLM алдаа (${response.status}).`, 502);
  const payload = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const rawText = payload.content?.find((block) => block.type === "text")?.text ?? "";
  const jsonStart = rawText.indexOf("{");
  const jsonEnd = rawText.lastIndexOf("}");
  let parsed: unknown = null;
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    try {
      parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd + 1));
    } catch {
      parsed = null;
    }
  }
  const reply = parseReply(parsed);
  if (!reply) return jsonError("LLM-ийн хариу хэлбэр таарсангүй.", 502);

  const body: Reply = { ...reply, received };
  return NextResponse.json(body);
}
