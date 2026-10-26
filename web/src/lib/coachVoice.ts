// Browser side of "hear it": the coach voice reading a sentence (/api/tts), and the speaker's
// own words played back from their recording using the word timings of the transcription.
import { t } from "./i18n";
import { currentLang, langHeaders } from "./i18nClient";

export interface WordTime {
  word: string;
  start: number;
  end: number;
}

// ---- Word timings, kept per stored recording ---------------------------------------------------

const timingsKey = (storageKey: string) => `pitchcoach:timings:${storageKey}`;

export function saveTimings(storageKey: string, words: WordTime[]) {
  try {
    if (words.length) localStorage.setItem(timingsKey(storageKey), JSON.stringify(words));
  } catch {
    /* storage full or blocked: playback of own words is simply unavailable */
  }
}

export function loadTimings(storageKey: string | undefined): WordTime[] {
  if (!storageKey) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(timingsKey(storageKey)) ?? "[]") as WordTime[];
    return Array.isArray(parsed) ? parsed.filter((w) => typeof w.start === "number" && typeof w.end === "number") : [];
  } catch {
    return [];
  }
}

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/**
 * Where a quote was said: the time span of its words in the recording. Matches the whole quote,
 * or else its first few words (the model sometimes trims or joins sentences). Null when not found.
 */
export function findQuote(quote: string, words: WordTime[]): { start: number; end: number } | null {
  const want = tokens(quote);
  if (want.length === 0 || words.length === 0) return null;
  const have = words.map((w) => tokens(w.word).join(" "));
  for (let len = want.length; len >= Math.min(3, want.length); len--) {
    const needle = want.slice(0, len);
    for (let i = 0; i + needle.length <= have.length; i++) {
      if (needle.every((w, j) => have[i + j] === w)) {
        const lastWord = Math.min(words.length - 1, i + want.length - 1); // span of the whole quote
        return { start: words[i].start, end: words[lastWord].end };
      }
    }
  }
  return null;
}

// ---- Playback ------------------------------------------------------------------------------------

let stopCurrent: (() => void) | null = null;

/** Stops whatever "hear it" sound is playing. */
export function stopListening() {
  stopCurrent?.();
  stopCurrent = null;
}

const spoken = new Map<string, string>(); // text -> object URL of the coach voice

/** The coach voice reads `text`. Resolves when it has finished (or was stopped). */
export async function speakText(text: string): Promise<void> {
  stopListening();
  let url = spoken.get(text);
  if (!url) {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...langHeaders() },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    if (!res?.ok) {
      const body = (await res?.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(typeof body?.error === "string" ? body.error : t(currentLang(), "ttsFail"));
    }
    url = URL.createObjectURL(await res.blob());
    spoken.set(text, url);
  }
  const audio = new Audio(url);
  return new Promise((resolve) => {
    const done = () => resolve();
    audio.onended = done;
    audio.onerror = done;
    stopCurrent = () => {
      audio.pause();
      done();
    };
    audio.play().catch(done);
  });
}

const decoded = new Map<Blob, Promise<AudioBuffer>>();
let ctx: AudioContext | null = null;

/**
 * Plays part of a recording. The blob is decoded once and the span played from memory, which works
 * for browser recordings (WebM) that often can't be seeked. A little padding keeps word edges.
 */
export async function playSpan(recording: Blob, start: number, end: number): Promise<void> {
  stopListening();
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  let buffer = decoded.get(recording);
  if (!buffer) {
    buffer = recording.arrayBuffer().then((data) => ctx!.decodeAudioData(data));
    decoded.set(recording, buffer);
  }
  const audio = await buffer;
  const from = Math.max(0, start - 0.25);
  const length = Math.min(audio.duration - from, end - start + 0.5);
  const source = ctx.createBufferSource();
  source.buffer = audio;
  source.connect(ctx.destination);
  return new Promise((resolve) => {
    source.onended = () => resolve();
    stopCurrent = () => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      resolve();
    };
    source.start(0, from, Math.max(0.1, length));
  });
}
