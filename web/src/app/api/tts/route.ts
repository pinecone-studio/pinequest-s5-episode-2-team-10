import { NextResponse } from "next/server";
import { langOf, t } from "@/lib/i18n";
import { speak, TTS_ENGINES, type TtsEngine } from "@/lib/server/tts";
import { VoiceError } from "@/lib/server/voice";

export const maxDuration = 60;

/** JSON `{text, engine?}` → the coach voice reading it (MP3 from Azure or ElevenLabs, WAV from the voice server). */
export async function POST(request: Request) {
  const lang = langOf(request);
  const body = (await request.json().catch(() => null)) as { text?: unknown; engine?: unknown } | null;
  if (typeof body?.text !== "string") {
    return NextResponse.json({ error: t(lang, "ttsEmpty") }, { status: 400 });
  }
  try {
    const engine = TTS_ENGINES.includes(body.engine as TtsEngine) ? (body.engine as TtsEngine) : undefined;
    const { audio, type } = await speak(body.text, lang, engine);
    return new Response(audio, { headers: { "Content-Type": type, "Cache-Control": "private, max-age=86400" } });
  } catch (err) {
    if (err instanceof VoiceError) return NextResponse.json({ error: err.message }, { status: err.status });
    return NextResponse.json({ error: t(lang, "ttsFail") }, { status: 500 });
  }
}
