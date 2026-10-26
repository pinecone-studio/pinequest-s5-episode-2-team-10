// Server only: delivery checks from the recording's word timings (and per-word loudness):
// rushed stretches, speeding up at the end, long pauses, bursts of fillers, and a voice that
// trails off. Rules only, no model; every finding names the moment and quotes the words there,
// so the page can play it back.
//
// Word times are estimates (pipeline/word_timing.py): pauses are real silences, but times inside
// a stretch of speech are spread evenly. So pace is measured over 30 s windows, never per word.
// Loudness depends on the microphone, so it is only compared within one recording.
// The limits below are first guesses for Mongolian pitches; tune them on real recordings.
import { t, type Lang } from "@/lib/i18n";
import type { Finding } from "./measure";
import { fillerList } from "./measure";

export interface TimedWord {
  word: string;
  start: number;
  end: number;
  db?: number; // loudness of the word, dB below full scale (voice server)
}

const MIN_WORDS = 30; // fewer words than this: too little to judge delivery
const MAX_WORDS = 3000; // about 5 minutes of fast speech; more is rejected as bad input

const PACE_WINDOW_S = 30;
const PACE_STEP_S = 10;
const RUSH_RATIO = 1.3; // a window this much faster than the speaker's usual pace…
const RUSH_MIN_GAIN_WPM = 25; // …and at least this many words/min faster counts as rushed
const END_SHARE = 0.25; // "the end" is the last quarter of the speaking time
const END_SPEEDUP_RATIO = 1.25;
const MIN_END_CHECK_S = 60;

const LONG_PAUSE_S = 3; // a silence this long in the middle of a pitch usually means a lost thread
const SENTENCE_GAP_S = 0.6; // same as textWithPauses in voice.ts

const FILLER_WINDOW_S = 20;
const FILLER_BURST = 4; // this many fillers within FILLER_WINDOW_S
const MAX_BURSTS = 2;

const TRAIL_MIN_WORDS = 5; // sentences shorter than this aren't checked for trailing off
const TRAIL_END_WORDS = 2;
// Both last words this much quieter than the rest of the sentence. Mongolian sentences end in
// verb endings and particles that are naturally softer, so one quiet last word isn't a fade.
const TRAIL_DROP_DB = 6;
const TRAIL_MIN_SENTENCES = 2;
const TRAIL_MIN_SHARE = 0.25;

const QUOTE_WORDS = 10;

const tokens = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** "1:05" */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const quoteOf = (ws: TimedWord[]) =>
  ws.length > QUOTE_WORDS ? `${ws.slice(0, QUOTE_WORDS).map((w) => w.word).join(" ")} …` : ws.map((w) => w.word).join(" ");

/** Checks the `words` form field: [{word, start, end, db?}], in time order. Null when malformed. */
export function parseTimedWords(raw: unknown): TimedWord[] | null {
  if (raw == null || raw === "") return [];
  let list: unknown;
  try {
    list = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length > MAX_WORDS) return null;
  const out: TimedWord[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") return null;
    const w = item as Record<string, unknown>;
    const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
    if (typeof w.word !== "string" || !ok(w.start) || !ok(w.end)) return null;
    const word = w.word.trim().slice(0, 60);
    if (!word) continue;
    const start = w.start as number;
    const end = Math.max(start, w.end as number);
    const db = typeof w.db === "number" && Number.isFinite(w.db) && w.db <= 0 ? w.db : undefined;
    out.push({ word, start, end, ...(db !== undefined ? { db } : {}) });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/** Words per minute in each window of the speech, by when each word starts. */
function paceWindows(words: TimedWord[]) {
  const first = words[0].start;
  const last = words[words.length - 1].end;
  const windows: { start: number; end: number; wpm: number; words: TimedWord[] }[] = [];
  for (let start = first; start + PACE_WINDOW_S <= last + 0.001; start += PACE_STEP_S) {
    const end = start + PACE_WINDOW_S;
    const inside = words.filter((w) => w.start >= start && w.start < end);
    windows.push({ start, end, wpm: (inside.length / PACE_WINDOW_S) * 60, words: inside });
  }
  return windows;
}

/** Words per minute between two times. */
function paceBetween(words: TimedWord[], from: number, to: number) {
  const n = words.filter((w) => w.start >= from && w.start < to).length;
  return to > from ? (n / (to - from)) * 60 : 0;
}

/** Splits the words where the speaker paused, like the transcript's sentences. */
function spokenRuns(words: TimedWord[]): TimedWord[][] {
  const runs: TimedWord[][] = [];
  words.forEach((w, i) => {
    if (i === 0 || w.start - words[i - 1].end >= SENTENCE_GAP_S) runs.push([]);
    runs[runs.length - 1].push(w);
  });
  return runs;
}

/** Indexes of the words that are fillers (single words and two-word phrases from the filler list). */
function fillerIndexes(words: TimedWord[]): number[] {
  const list = new Set(fillerList());
  const toks = words.map((w) => tokens(w.word).join(" "));
  const hits: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (i + 1 < toks.length && list.has(`${toks[i]} ${toks[i + 1]}`)) {
      hits.push(i);
      i++; // a two-word filler counts once
    } else if (list.has(toks[i])) {
      hits.push(i);
    }
  }
  return hits;
}

export interface DeliveryFacts {
  wpm: number | null; // the speaker's usual pace (median over 30 s windows)
  longPauses: number;
  fillerBursts: number;
  trailingSentences: number;
  checkedSentences: number;
}

/** Delivery findings for the recording, plus the plain numbers behind them. */
export function measureDelivery(words: TimedWord[], lang: Lang): { findings: Finding[]; facts: DeliveryFacts } {
  const findings: Finding[] = [];
  const facts: DeliveryFacts = { wpm: null, longPauses: 0, fillerBursts: 0, trailingSentences: 0, checkedSentences: 0 };
  if (words.length < MIN_WORDS) return { findings, facts };
  const add = (title: string, why: string, action: string, quote: string) =>
    findings.push({ source: "measured", title, why, action, example: "", quote });

  // ---- Pace -------------------------------------------------------------------------------------
  const windows = paceWindows(words);
  if (windows.length >= 2) {
    const usual = median(windows.map((w) => w.wpm));
    facts.wpm = Math.round(usual);
    const first = words[0].start;
    const last = words[words.length - 1].end;
    const endFrom = last - (last - first) * END_SHARE;
    let endReported = false;
    if (last - first >= MIN_END_CHECK_S) {
      const before = paceBetween(words, first, endFrom);
      const after = paceBetween(words, endFrom, last + 0.001);
      if (before > 0 && after >= before * END_SPEEDUP_RATIO) {
        endReported = true;
        const endWords = words.filter((w) => w.start >= endFrom);
        add(t(lang, "deliveryEndRushTitle"),
          t(lang, "deliveryEndRushWhy", { at: clock(endFrom), after: Math.round(after), before: Math.round(before) }),
          t(lang, "deliveryEndRushAction"), quoteOf(endWords));
      }
    }
    const fastest = windows.reduce((a, b) => (b.wpm > a.wpm ? b : a));
    const inEnd = fastest.start >= endFrom - PACE_STEP_S;
    if (fastest.wpm >= usual * RUSH_RATIO && fastest.wpm - usual >= RUSH_MIN_GAIN_WPM && !(endReported && inEnd)) {
      add(t(lang, "deliveryRushTitle"),
        t(lang, "deliveryRushWhy", { from: clock(fastest.start), to: clock(fastest.end), wpm: Math.round(fastest.wpm), usual: Math.round(usual) }),
        t(lang, "deliveryRushAction"), quoteOf(fastest.words));
    }
  }

  // ---- Long pauses ------------------------------------------------------------------------------
  const pauses: { at: number; seconds: number; next: number }[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= LONG_PAUSE_S) pauses.push({ at: words[i - 1].end, seconds: gap, next: i });
  }
  facts.longPauses = pauses.length;
  if (pauses.length) {
    const times = pauses.slice(0, 3).map((p) => `${clock(p.at)} (${p.seconds.toFixed(1)} s)`).join(", ");
    const longest = pauses.reduce((a, b) => (b.seconds > a.seconds ? b : a));
    add(t(lang, "deliveryPauseTitle"), t(lang, "deliveryPauseWhy", { times, limit: LONG_PAUSE_S }),
      t(lang, "deliveryPauseAction"), quoteOf(words.slice(longest.next, longest.next + QUOTE_WORDS)));
  }

  // ---- Bursts of fillers --------------------------------------------------------------------------
  const hits = fillerIndexes(words);
  const bursts: { from: number; to: number; count: number }[] = [];
  let i = 0;
  while (i < hits.length && bursts.length < MAX_BURSTS) {
    let j = i;
    while (j + 1 < hits.length && words[hits[j + 1]].start - words[hits[i]].start <= FILLER_WINDOW_S) j++;
    if (j - i + 1 >= FILLER_BURST) {
      bursts.push({ from: hits[i], to: hits[j], count: j - i + 1 });
      i = j + 1;
    } else {
      i++;
    }
  }
  facts.fillerBursts = bursts.length;
  if (bursts.length) {
    const where = bursts.map((b) => `${clock(words[b.from].start)}–${clock(words[b.to].end)} (${b.count})`).join(", ");
    const worst = bursts.reduce((a, b) => (b.count > a.count ? b : a));
    add(t(lang, "deliveryFillerBurstTitle"), t(lang, "deliveryFillerBurstWhy", { where }),
      t(lang, "deliveryFillerBurstAction"), quoteOf(words.slice(worst.from, worst.to + 1)));
  }

  // ---- Trailing off ---------------------------------------------------------------------------------
  const checked = spokenRuns(words).filter(
    (run) => run.length >= TRAIL_MIN_WORDS && run.every((w) => w.db !== undefined),
  );
  const trailing = checked
    .map((run) => {
      const body = median(run.slice(0, -TRAIL_END_WORDS).map((w) => w.db as number));
      const tail = Math.max(...run.slice(-TRAIL_END_WORDS).map((w) => w.db as number));
      return { run, drop: body - tail };
    })
    .filter((r) => r.drop >= TRAIL_DROP_DB);
  facts.checkedSentences = checked.length;
  facts.trailingSentences = trailing.length;
  if (trailing.length >= TRAIL_MIN_SENTENCES && trailing.length >= checked.length * TRAIL_MIN_SHARE) {
    const worst = trailing.reduce((a, b) => (b.drop > a.drop ? b : a));
    add(t(lang, "deliveryTrailTitle"),
      t(lang, "deliveryTrailWhy", { n: trailing.length, total: checked.length, at: clock(worst.run[0].start), db: Math.round(worst.drop) }),
      t(lang, "deliveryTrailAction"), quoteOf(worst.run.slice(-QUOTE_WORDS)));
  }

  return { findings, facts };
}
