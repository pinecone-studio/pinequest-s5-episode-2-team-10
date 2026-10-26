// Server only: the coach voice. PITCH_TTS picks the engine:
//   auto (default): Azure's Mongolian neural voice when AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are
//     set, otherwise MMS-TTS on the voice server (POST /v1/tts, free, offline);
//   voice | azure | elevenlabs: that engine. ElevenLabs has no Mongolian model (it rejects
//     language_code "mn"); it reads the Cyrillic anyway, so it is here for comparison.
import { t, type Lang } from "@/lib/i18n";
import { serverSetting as setting, VoiceError, voiceConfig } from "./voice";

export const MAX_SPEAK_CHARS = 600;
const CACHE_LIMIT = 200;

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

export type TtsEngine = "voice" | "azure" | "elevenlabs";
export const TTS_ENGINES: TtsEngine[] = ["voice", "azure", "elevenlabs"];

export function ttsBackend(): TtsEngine {
  const chosen = setting("PITCH_TTS") as TtsEngine | "auto" | undefined;
  if (chosen && TTS_ENGINES.includes(chosen as TtsEngine)) return chosen as TtsEngine;
  return setting("AZURE_SPEECH_KEY") && setting("AZURE_SPEECH_REGION") ? "azure" : "voice";
}

export interface TtsEngineStatus {
  id: TtsEngine;
  available: boolean;
  reason: string | null; // why it can't be used here
}

/** Which voices this server is set up for (keys present). The voice server may still be offline. */
export function ttsEngines(lang: Lang): { engines: TtsEngineStatus[]; defaultEngine: TtsEngine } {
  const missing = (names: string[]) => names.filter((n) => !setting(n));
  const status = (id: TtsEngine, need: string[]): TtsEngineStatus => {
    const gone = missing(need);
    return { id, available: gone.length === 0, reason: gone.length ? t(lang, "ttsNeedsKey", { keys: gone.join(", ") }) : null };
  };
  return {
    engines: [
      voiceConfig().token
        ? { id: "voice", available: true, reason: null }
        : { id: "voice", available: false, reason: t(lang, "voiceTokenMissing") },
      status("azure", ["AZURE_SPEECH_KEY", "AZURE_SPEECH_REGION"]),
      status("elevenlabs", ["ELEVENLABS_API_KEY"]),
    ],
    defaultEngine: ttsBackend(),
  };
}

async function elevenlabs(text: string, lang: Lang): Promise<Speech> {
  const key = setting("ELEVENLABS_API_KEY");
  if (!key) throw new VoiceError(t(lang, "ttsFail"), 503);
  const voice = setting("PITCH_ELEVENLABS_VOICE") || "JBFqnCBsd6RMkjVDRZzb";
  const model = setting("PITCH_ELEVENLABS_MODEL") || "eleven_v3";
  let res: Response;
  try {
    res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`, {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model }),
    });
  } catch {
    throw new VoiceError(t(lang, "ttsFail"), 502);
  }
  if (!res.ok) throw new VoiceError(t(lang, "ttsFail"), 502);
  return { audio: await res.arrayBuffer(), type: "audio/mpeg" };
}

async function azure(text: string, lang: Lang): Promise<Speech> {
  if (!setting("AZURE_SPEECH_KEY") || !setting("AZURE_SPEECH_REGION")) {
    throw new VoiceError(t(lang, "ttsFail"), 503);
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

async function voiceServer(text: string, lang: Lang): Promise<Speech> {
  const { url, token } = voiceConfig();
  if (!token) throw new VoiceError(t(lang, "voiceTokenMissing"), 503);
  let res: Response;
  try {
    res = await fetch(`${url}/v1/tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch {
    throw new VoiceError(t(lang, "voiceDown"), 502);
  }
  if (res.status === 401) throw new VoiceError(t(lang, "voiceTokenWrong"), 502);
  if (res.status === 404) throw new VoiceError(t(lang, "ttsNotOnServer"), 502);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    throw new VoiceError(typeof body?.message === "string" ? body.message : t(lang, "ttsFail"), res.status >= 500 ? 502 : 400);
  }
  return { audio: await res.arrayBuffer(), type: "audio/wav" };
}

/** `text` read aloud in Mongolian, by `engine` or the configured one. */
export async function speak(text: string, lang: Lang, engine: TtsEngine = ttsBackend()): Promise<Speech> {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new VoiceError(t(lang, "ttsEmpty"), 400);
  if (clean.length > MAX_SPEAK_CHARS) throw new VoiceError(t(lang, "ttsTooLong"), 413);
  const key = `${engine}:${clean}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const run = { voice: voiceServer, azure, elevenlabs }[engine];
  return remember(key, await run(clean, lang));
}
