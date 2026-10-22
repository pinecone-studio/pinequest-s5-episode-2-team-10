import { connection, NextResponse } from "next/server";
import { langOf, t } from "@/lib/i18n";
import { transcribe, VoiceError, voiceHealth } from "@/lib/server/voice";

const MAX_FILE = 25 * 1024 * 1024;

/** Voice server status, for the test panel. */
export async function GET(request: Request) {
  await connection();
  return NextResponse.json(await voiceHealth(langOf(request)));
}

/** Multipart `file` → {text, words, durationS, elapsedS}. The token stays on the server. */
export async function POST(request: Request) {
  const lang = langOf(request);
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: t(lang, "badForm") }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: t(lang, "noAudioFile") }, { status: 400 });
  }
  if (file.size > MAX_FILE) {
    return NextResponse.json({ error: t(lang, "audioTooBig") }, { status: 413 });
  }
  try {
    return NextResponse.json(await transcribe(file, file.name || "audio.webm", lang));
  } catch (err) {
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: t(lang, "sttFail") }, { status: 500 });
  }
}
