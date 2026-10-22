// Server only: things code can measure in the speech exactly, so they never depend on a model:
// filler words, back-to-back repeats, very long or run-on sentences, and slide numbers that
// weren't said as written (the model then says what was said instead; code checks the quote).
import { readFileSync } from "node:fs";
import path from "node:path";
import { t, type Lang } from "@/lib/i18n";
import type { Sentence } from "./points";

export interface Finding {
  source: "measured";
  title: string;
  why: string;
  action: string;
  example: string;
  quote: string; // from the speech, shortened with "…" when long
}

const LONG_SENTENCE_WORDS = 25; // same limit as pipeline/text_checks.py
const RUN_ON_LINKS = 3; // "тэгээд" this many times in one sentence
const QUOTE_WORDS = 14;
const MAX_NUMBER_CANDIDATES = 12;

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

let fillerCache: string[] | null = null;
/** pipeline/fillers_mn.txt, longest phrase first so "тэгээд тэгээд" is counted before "тэгээд". */
export function fillerList(): string[] {
  if (fillerCache) return fillerCache;
  try {
    fillerCache = readFileSync(path.join(process.cwd(), "..", "pipeline", "fillers_mn.txt"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l && !l.startsWith("#"))
      .sort((a, b) => b.length - a.length);
  } catch {
    fillerCache = ["тэгээд тэгээд", "за тэгээд", "юу гэдэг юм", "нөгөө", "яахав", "ээм", "аан", "хмм", "ээ", "аа", "мм"];
  }
  return fillerCache;
}

function shortQuote(text: string): string {
  const parts = text.split(/\s+/);
  return parts.length > QUOTE_WORDS ? `${parts.slice(0, QUOTE_WORDS).join(" ")} …` : text;
}

/** Filler counts over the whole speech (phrases first, each word counted once). */
export function countFillers(sentences: Sentence[]) {
  const counts = new Map<string, number>();
  let firstSentence: Sentence | null = null;
  for (const s of sentences) {
    let joined = ` ${words(s.text).join(" ")} `;
    for (const f of fillerList()) {
      const parts = joined.split(` ${f} `);
      if (parts.length > 1) {
        counts.set(f, (counts.get(f) ?? 0) + parts.length - 1);
        joined = parts.join(" ");
        firstSentence ??= s;
      }
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  return { counts, total, firstSentence };
}

/** Sentences split only where the speaker ended one (punctuation, which pauses become), never by length. */
export function spokenSentences(text: string): Sentence[] {
  return text
    .split(/(?<=[.?!…])\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, id) => ({ id, text: t }));
}

/**
 * Code findings for the speech; each one becomes a "measured" item in the improvement list.
 * Uses spokenSentences, so a long sentence isn't hidden by the 20-word pieces the model sees.
 */
export function measureSpeech(speech: string, lang: Lang): Finding[] {
  const sentences = spokenSentences(speech);
  const findings: Finding[] = [];
  const add = (title: string, why: string, action: string, quote = "") =>
    findings.push({ source: "measured", title, why, action, example: "", quote });
  const allWords = sentences.flatMap((s) => words(s.text));
  if (allWords.length === 0) return findings;

  const fillers = countFillers(sentences);
  if (fillers.total > 0) {
    const list = [...fillers.counts].sort((a, b) => b[1] - a[1]).map(([w, n]) => `«${w}» ×${n}`).join(", ");
    const per100 = Math.round((fillers.total / allWords.length) * 1000) / 10;
    add(t(lang, "rulesFillers"), t(lang, "rulesFillersFound", { list, per100 }), t(lang, "rulesFillersAction"),
      fillers.firstSentence ? shortQuote(fillers.firstSentence.text) : "");
  }

  const fillerSet = new Set(fillerList());
  const repeats = new Map<string, number>();
  let repeatQuote = "";
  for (const s of sentences) {
    const w = words(s.text);
    for (let i = 1; i < w.length; i++) {
      if (w[i] === w[i - 1] && w[i].length > 1 && !fillerSet.has(`${w[i]} ${w[i]}`)) {
        repeats.set(w[i], (repeats.get(w[i]) ?? 0) + 1);
        repeatQuote ||= shortQuote(s.text);
      }
    }
  }
  if (repeats.size) {
    add(t(lang, "rulesRepeats"), [...repeats].map(([w, n]) => `«${w} ${w}» ×${n}`).join(", "), t(lang, "rulesRepeatsAction"), repeatQuote);
  }

  const long = sentences.filter((s) => words(s.text).length > LONG_SENTENCE_WORDS);
  if (long.length) {
    add(t(lang, "longTitle"), t(lang, "longWhy", { n: long.length, limit: LONG_SENTENCE_WORDS }), t(lang, "longAction"),
      shortQuote(long[0].text));
  }

  const runOn = sentences.find((s) => words(s.text).filter((w) => w === "тэгээд").length >= RUN_ON_LINKS);
  if (runOn) {
    const n = words(runOn.text).filter((w) => w === "тэгээд").length;
    add(t(lang, "runOnTitle"), t(lang, "runOnWhy", { n }), t(lang, "runOnAction"), shortQuote(runOn.text));
  }
  return findings;
}

/**
 * Numbers on the slides that the speech doesn't contain as written: decimals, percentages and
 * numbers of two or more digits (small counts like slide or step numbers are left out).
 * The model is asked what the speaker said instead of each.
 */
// "320,768" is a thousands separator; "0,96" is a decimal comma.
const NUMBER = /\d{1,3}(?:,\d{3})+(?![\d.])|\d+(?:[.,]\d+)?/g;
const norm = (n: string) =>
  (/^\d{1,3}(,\d{3})+$/.test(n) ? n.replace(/,/g, "") : n.replace(",", ".")).replace(/\.0+$/, "");

/** The first number in `text` as a plain value ("0.96 AUC" -> "0.96"), or "". */
export function numberValue(text: string): string {
  const m = text.match(new RegExp(NUMBER.source));
  return m ? norm(m[0]) : "";
}

// A figure followed by one of these is a stat worth checking ("0.9 s", "6.4 MB", "30 хувь").
const UNIT = /^\s?(%|s\b|sec|ms\b|mb\b|gb\b|kb\b|x\b|сек|минут|цаг|хувь|сая|мянга|тэрбум|төгрөг|₮|\$)/i;

interface SlideNumber {
  raw: string; // as written on the slide, e.g. "0.96" or "6.4 MB"
  value: string; // normalised, e.g. "0.96" or "6.4"
  unit: string; // unit group: "time", "size", "percent", "money" or "" for none
}

/** Which kind of unit follows a number: "0.9 s" and "гурван секунд" are both time. */
function unitGroup(after: string): string {
  const u = after.match(UNIT)?.[0].trim().toLowerCase() ?? "";
  if (!u) return "";
  if (/^(s|sec|ms|сек|минут|цаг)/.test(u)) return "time";
  if (/^(mb|gb|kb)/.test(u)) return "size";
  if (/^(%|хувь)/.test(u)) return "percent";
  if (/^(сая|мянга|тэрбум|төгрөг|₮|\$)/.test(u)) return "money";
  return "other";
}

/**
 * Figures on the slides that look like stats: decimals, percentages, numbers of 1000 or more,
 * and numbers with a unit. Bare small integers (case numbers, scores in a table, step numbers)
 * are left out; they are rarely things the speaker must say.
 */
function slideStats(slideText: string): SlideNumber[] {
  const out: SlideNumber[] = [];
  for (const m of slideText.matchAll(NUMBER)) {
    const value = norm(m[0]);
    const after = slideText.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 8);
    const unit = after.match(UNIT)?.[0].trim() ?? "";
    const stat = Boolean(unit) || value.includes(".") || Number(value) >= 1000;
    if (stat && !out.some((n) => n.value === value)) {
      out.push({ raw: unit ? `${m[0]} ${unit}` : m[0], value, unit: unitGroup(after) });
    }
  }
  return out;
}

const spokenNumbers = (speech: string) => new Set((speech.match(NUMBER) ?? []).map(norm));

/** Slide stats the speech doesn't contain as written; the model is asked what was said instead of each. */
export function numberCandidates(slideText: string, sentences: Sentence[]): string[] {
  const said = spokenNumbers(sentences.map((s) => s.text).join(" "));
  return slideStats(slideText)
    .filter((n) => !said.has(n.value))
    .map((n) => n.raw)
    .slice(0, MAX_NUMBER_CANDIDATES);
}

/**
 * Decimal or whole, order of magnitude, and unit group: 0.86 and 0.96 are the same kind;
 * 0.86 and 86 are not, and neither are 0.86 and "0.9 s".
 */
function kind(value: string, unit: string): string {
  const n = Math.abs(Number(value));
  return `${value.includes(".") ? "dec" : "int"}:${n === 0 ? 0 : Math.floor(Math.log10(n))}:${unit}`;
}

/**
 * Numbers said that aren't on the slides, paired with an unspoken slide stat of the same kind:
 * "the slides show 0.96, you said 0.86". No model needed; figures said in words are left to the model.
 */
export function numberMismatches(slideText: string, speech: string, lang: Lang): Finding[] {
  const stats = slideStats(slideText);
  const onSlides = new Set(stats.map((n) => n.value));
  const said = spokenNumbers(speech);
  const unspoken = stats.filter((n) => !said.has(n.value));
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const sentence of spokenSentences(speech)) {
    for (const m of sentence.text.matchAll(NUMBER)) {
      const value = norm(m[0]);
      if (onSlides.has(value) || !value.includes(".") && Number(value) < 10) continue;
      const after = sentence.text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 10);
      const spoken = kind(value, unitGroup(after));
      const sameKind = unspoken.filter((n) => kind(n.value, n.unit) === spoken && !used.has(n.value));
      if (!sameKind.length) continue;
      const closest = sameKind.reduce((a, b) =>
        Math.abs(Number(b.value) - Number(value)) < Math.abs(Number(a.value) - Number(value)) ? b : a);
      used.add(closest.value);
      findings.push({
        source: "measured",
        title: t(lang, "numberTitle"),
        why: t(lang, "numberWhyPair", { slide: closest.raw, said: m[0] }),
        action: t(lang, "numberAction"),
        example: "",
        quote: shortQuote(sentence.text),
      });
    }
  }
  return findings.slice(0, 3);
}
