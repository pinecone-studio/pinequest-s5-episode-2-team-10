// Server only: the coach voice. PITCH_TTS picks the engine:
//   auto (default): ElevenLabs when ELEVENLABS_API_KEY is set, otherwise Azure's Mongolian neural
//     voice (AZURE_SPEECH_KEY and AZURE_SPEECH_REGION);
//   azure | elevenlabs: that engine. ElevenLabs uses eleven_v4_turbo (Mongolian, fastest)
//     unless PITCH_ELEVENLABS_MODEL picks another model.
// Both are billed services, so reading stops for the day after PITCH_TTS_PAID_DAILY_CHARS
// characters (default 20000; 0 = no limit) and an open demo can't run up a bill. The count is per
// server process, so on serverless hosts it is a safety net, not an exact quota.
import { t, type Lang } from "@/lib/i18n";
import { serverSetting as setting, VoiceError } from "./voice";

export const MAX_SPEAK_CHARS = 600;
const CACHE_LIMIT = 200;
const DEFAULT_PAID_DAILY_CHARS = 20_000;

let paidDay = "";
let paidUsed = 0;

/**
 * Counts `chars` against today's paid allowance; false when it would go over (nothing is counted).
 * `limit` 0 means no limit. Exported for tests.
 */
export function spendPaidChars(chars: number, limit: number, now = new Date()): boolean {
  const day = now.toISOString().slice(0, 10);
  if (day !== paidDay) {
    paidDay = day;
    paidUsed = 0;
  }
  if (limit > 0 && paidUsed + chars > limit) return false;
  paidUsed += chars;
  return true;
}

function paidDailyLimit(): number {
  const raw = setting("PITCH_TTS_PAID_DAILY_CHARS");
  const n = raw === "" ? DEFAULT_PAID_DAILY_CHARS : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PAID_DAILY_CHARS;
}

export interface Speech {
  audio: ArrayBuffer;
  type: string;
}

// The same sentence is often played again (and by several viewers), so keep recent results.
const cache = new Map<string, Speech>();

function remember(key: string, speech: Speech): Speech {
  cache.set(key, speech);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return speech;
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

export type TtsEngine = "azure" | "elevenlabs";
export const TTS_ENGINES: TtsEngine[] = ["azure", "elevenlabs"];

export function ttsBackend(): TtsEngine {
  const chosen = setting("PITCH_TTS") as TtsEngine | "auto" | undefined;
  if (chosen && TTS_ENGINES.includes(chosen as TtsEngine)) return chosen as TtsEngine;
  if (setting("ELEVENLABS_API_KEY")) return "elevenlabs";
  return setting("AZURE_SPEECH_KEY") && setting("AZURE_SPEECH_REGION") ? "azure" : "elevenlabs";
}

export interface TtsEngineStatus {
  id: TtsEngine;
  available: boolean;
  reason: string | null; // why it can't be used here
}

/** Which voices this server is set up for (keys present). */
export function ttsEngines(lang: Lang): { engines: TtsEngineStatus[]; defaultEngine: TtsEngine } {
  const missing = (names: string[]) => names.filter((n) => !setting(n));
  const status = (id: TtsEngine, need: string[]): TtsEngineStatus => {
    const gone = missing(need);
    return { id, available: gone.length === 0, reason: gone.length ? t(lang, "ttsNeedsKey", { keys: gone.join(", ") }) : null };
  };
  return {
    engines: [
      status("azure", ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]),
      status("elevenlabs", ["ELEVENLABS_API_KEY"]),
    ],
    defaultEngine: ttsBackend(),
  };
}

async function elevenlabs(text: string, lang: Lang): Promise<Speech> {
  const key = setting("ELEVENLABS_API_KEY");
  if (!key) throw new VoiceError(t(lang, "ttsNotConfigured"), 503);
  const voice = setting("PITCH_ELEVENLABS_VOICE") || "JBFqnCBsd6RMkjVDRZzb";
  const model = setting("PITCH_ELEVENLABS_MODEL") || "eleven_v4_turbo";
  // v4 models take language_code "mn"; eleven_v3 reads Mongolian too but rejects the code.
  const languageCode = model.startsWith("eleven_v3") ? undefined : "mn";
  let res: Response;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, language_code: languageCode }),
    });
  } catch {
    throw new VoiceError(t(lang, "ttsFail"), 502);
  }
  if (!res.ok) throw new VoiceError(t(lang, "ttsFail"), 502);
  return { audio: await res.arrayBuffer(), type: "audio/mpeg" };
}

async function azure(text: string, lang: Lang): Promise<Speech> {
  if (!setting("AZURE_SPEECH_KEY") || !setting("AZURE_SPEECH_REGION")) {
    throw new VoiceError(t(lang, "ttsNotConfigured"), 503);
  }
  const region = setting("AZURE_SPEECH_REGION");
  const voice = setting("PITCH_TTS_VOICE") || "mn-MN-YesuiNeural";
  const ssml = `<speak version="1.0" xml:lang="mn-MN"><voice name="${escapeXml(voice)}">${escapeXml(text)}</voice></speak>`;
  let res: Response;
  try {
    res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": setting("AZURE_SPEECH_KEY"),
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "saylo",
      },
      body: ssml,
    });
  } catch {
    throw new VoiceError(t(lang, "ttsFail"), 502);
  }
  if (!res.ok) throw new VoiceError(t(lang, "ttsFail"), 502);
  return { audio: await res.arrayBuffer(), type: "audio/mpeg" };
}

/** `text` read aloud in Mongolian, by `engine` or the configured one. */
export async function speak(text: string, lang: Lang, engine: TtsEngine = ttsBackend()): Promise<Speech> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new VoiceError(t(lang, "ttsEmpty"), 400);
  if (clean.length > MAX_SPEAK_CHARS) throw new VoiceError(t(lang, "ttsTooLong"), 413);
  const key = `${engine}:${clean}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!spendPaidChars(clean.length, paidDailyLimit())) {
    throw new VoiceError(t(lang, "ttsDailyLimit"), 429);
  }
  const run = { azure, elevenlabs }[engine];
  return remember(key, await run(clean, lang));
}
