import { connection, NextResponse } from "next/server";
import { transcribe, VoiceError, voiceHealth } from "@/lib/server/voice";

const MAX_FILE = 25 * 1024 * 1024;

/** Voice server status, for the test panel. */
export async function GET() {
  await connection();
  return NextResponse.json(await voiceHealth());
}

/** Multipart `file` → {text, words, durationS, elapsedS}. The token stays on the server. */
export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Илгээсэн өгөгдлийг уншиж чадсангүй." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "Аудио файл алга." }, { status: 400 });
  }
  if (file.size > MAX_FILE) {
    return NextResponse.json({ error: "Аудио 25 MB-аас том байна." }, { status: 413 });
  }
  try {
    return NextResponse.json(await transcribe(file, file.name || "audio.webm"));
  } catch (err) {
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: "Яриаг текст болгож чадсангүй." }, { status: 500 });
  }
}
