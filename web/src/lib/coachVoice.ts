// Browser side of "hear it": the coach voice reading a sentence (/api/tts), and the speaker's
// own words played back from their recording using the word timings of the transcription.
import { t, type Lang } from "./i18n";
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
let generation = 0; // bumped by every stop, so a waiting player knows it was cancelled

/** Stops whatever "hear it" sound is playing, including a whole read-aloud. */
export function stopListening() {
  generation++;
  stopCurrent?.();
  stopCurrent = null;
}

// ---- Which voice reads -----------------------------------------------------------------------------

export type TtsEngine = "voice" | "azure" | "elevenlabs";
export type TtsChoice = TtsEngine | "auto"; // auto: the server's default
const TTS_CHOICES: TtsChoice[] = ["auto", "voice", "azure", "elevenlabs"];
const TTS_KEY = "pitchcoach:tts-engine";
const ttsListeners = new Set<() => void>();
let ttsChoice: TtsChoice | null = null;

export const isTtsChoice = (v: unknown): v is TtsChoice => TTS_CHOICES.includes(v as TtsChoice);

/** The voice chosen in this browser (remembered when storage is allowed). */
export function getTtsChoice(): TtsChoice {
  if (ttsChoice) return ttsChoice;
  try {
    const saved = localStorage.getItem(TTS_KEY);
    ttsChoice = isTtsChoice(saved) ? saved : "auto";
  } catch {
    ttsChoice = "auto"; // storage blocked
  }
  return ttsChoice;
}

export function setTtsChoice(next: TtsChoice) {
  if (next === getTtsChoice()) return;
  stopListening(); // don't keep reading in the old voice
  ttsChoice = next;
  try {
    localStorage.setItem(TTS_KEY, next);
  } catch {
    /* storage blocked; the choice lasts until reload */
  }
  ttsListeners.forEach((l) => l());
}

export function subscribeTts(listener: () => void) {
  ttsListeners.add(listener);
  return () => ttsListeners.delete(listener);
}

const spoken = new Map<string, Promise<string>>(); // voice + text -> object URL of the coach voice

/** The coach voice for `text` (fetched once; a failed fetch is forgotten so it can be retried). */
function fetchSpeech(text: string): Promise<string> {
  const choice = getTtsChoice();
  const engine = choice === "auto" ? undefined : choice;
  const key = `${choice}:${text}`;
  let url = spoken.get(key);
  if (!url) {
    url = (async () => {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...langHeaders() },
        body: JSON.stringify({ text, engine }),
      }).catch(() => null);
      if (!res?.ok) {
        const body = (await res?.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(typeof body?.error === "string" ? body.error : t(currentLang(), "ttsFail"));
      }
      return URL.createObjectURL(await res.blob());
    })();
    url.catch(() => spoken.delete(key));
    spoken.set(key, url);
  }
  return url;
}

function playUrl(url: string): Promise<void> {
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

/** The coach voice reads `text`. Resolves when it has finished (or was stopped). */
export async function speakText(text: string): Promise<void> {
  stopListening();
  const run = generation;
  const url = await fetchSpeech(text);
  if (run === generation) await playUrl(url);
}

const decoded = new Map<Blob, Promise<AudioBuffer>>();
let ctx: AudioContext | null = null;

export interface Clip {
  recording: Blob;
  start: number;
  end: number;
}

async function playClip({ recording, start, end }: Clip, run: number): Promise<void> {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") await ctx.resume();
  let buffer = decoded.get(recording);
  if (!buffer) {
    buffer = recording.arrayBuffer().then((data) => ctx!.decodeAudioData(data));
    buffer.catch(() => decoded.delete(recording));
    decoded.set(recording, buffer);
  }
  const audio = await buffer;
  if (run !== generation) return;
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

/**
 * Plays part of a recording. The blob is decoded once and the span played from memory, which works
 * for browser recordings (WebM) that often can't be seeked. A little padding keeps word edges.
 */
export async function playSpan(recording: Blob, start: number, end: number): Promise<void> {
  stopListening();
  await playClip({ recording, start, end }, generation);
}

// ---- Reading the whole analysis aloud --------------------------------------------------------------

/** One part of a read-aloud: the coach voice saying `say`, or a clip of the speaker's own words. */
export interface ReadStep {
  key: string; // which item on screen is being read, for highlighting
  say?: string;
  clip?: () => Promise<Clip | null>;
}

const SPEAK_CHUNK = 450; // the server reads at most 600 characters at a time

/** Splits long text at sentence ends (then at spaces) into pieces the server will read. */
export function speechChunks(text: string, max = SPEAK_CHUNK): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
  const out: string[] = [];
  let piece = "";
  const push = (s: string) => {
    if (s.trim()) out.push(s.trim());
  };
  for (const sentence of sentences) {
    if ((piece + sentence).length <= max) {
      piece += sentence;
      continue;
    }
    push(piece);
    piece = "";
    let rest = sentence;
    while (rest.length > max) {
      const cut = rest.lastIndexOf(" ", max) > 0 ? rest.lastIndexOf(" ", max) : max;
      push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    piece = rest;
  }
  push(piece);
  return out;
}

/**
 * Reads the steps one after another; `onStep` gets the key being read, then null at the end.
 * The next part's voice is fetched while the current one plays, so there are no long gaps.
 * Stops when stopListening() is called (or another sound starts).
 */
export async function readAloud(steps: ReadStep[], onStep: (key: string | null) => void): Promise<void> {
  stopListening();
  const run = generation;
  const parts = steps.flatMap((step) =>
    step.say ? speechChunks(step.say).map((say) => ({ key: step.key, say, clip: undefined })) : step.clip ? [step] : [],
  );
  const nextSay = (from: number) => parts.slice(from).find((p) => p.say)?.say;
  try {
    for (let i = 0; i < parts.length && run === generation; i++) {
      const part = parts[i];
      onStep(part.key);
      const ahead = nextSay(i + 1);
      if (ahead) fetchSpeech(ahead).catch(() => {}); // a failure shows up when its turn comes
      if (part.say) {
        const url = await fetchSpeech(part.say);
        if (run === generation) await playUrl(url);
      } else if (part.clip) {
        const clip = await part.clip().catch(() => null);
        if (clip && run === generation) await playClip(clip, run).catch(() => {}); // own words are a bonus
      }
    }
  } finally {
    onStep(null);
  }
}

const sentence = (text: string) => {
  const s = text.trim();
  return !s || /[.!?…:]$/.test(s) ? s : `${s}.`;
};

/**
 * The analysis as a read-aloud: the summary, the strengths, then each thing to improve with what to
 * do, the speaker's own words (when their timing is known) and a better way to say it.
 */
export function feedbackSteps(
  result: {
    summary: string;
    strengths: { text: string }[];
    improvements: { title: string; action: string; example: string; quote: string }[];
  },
  lang: Lang,
  clipFor: (quote: string) => (() => Promise<Clip | null>) | null,
): ReadStep[] {
  const steps: ReadStep[] = [];
  if (result.summary.trim()) steps.push({ key: "summary", say: sentence(result.summary) });
  result.strengths.forEach((s, i) => {
    const intro = i === 0 ? `${t(lang, "strengths")}. ` : "";
    if (s.text.trim()) steps.push({ key: `s${i}`, say: intro + sentence(s.text) });
  });
  result.improvements.forEach((item, i) => {
    const key = `i${i}`;
    const intro = i === 0 ? `${t(lang, "improvements")}. ` : "";
    steps.push({ key, say: `${intro}${i + 1}. ${sentence(item.title)} ${sentence(item.action)}` });
    const clip = item.quote ? clipFor(item.quote) : null;
    if (clip) steps.push({ key, say: t(lang, "readYouSaid") }, { key, clip });
    if (item.example.trim()) steps.push({ key, say: `${t(lang, "readTrySaying")} ${sentence(item.example)}` });
  });
  return steps;
}
