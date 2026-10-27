// Server only: the main points check for the folder page's "send to model" route.
// Same rules as pipeline/points.py (keep them in step): the model judges each point and quotes
// the transcript; code checks every quote, quotes off-topic sentences itself, and computes coverage.

export const MAX_POINTS = 6;
export const MAX_POINT_CHARS = 200;
const STATUSES = ["covered", "partial", "missed"] as const;
type Status = (typeof STATUSES)[number];
const STATUS_VALUE: Record<Status, number> = { covered: 1, partial: 0.5, missed: 0 };

const PREFIX = 5;
const RULES_COVERED = 0.6;
const RULES_PARTIAL = 0.3;
const STOPWORDS = new Set([
  "бол", "нь", "юм", "энэ", "тэр", "эдгээр", "тэдгээр", "бид", "би", "та", "манай", "бидний", "миний",
  "ба", "болон", "мөн", "гэж", "гэх", "гэсэн", "байна", "байгаа", "байдаг", "байсан", "байх", "бөгөөд",
  "их", "маш", "нэг", "ямар", "юу", "яаж", "хэрхэн", "учир", "тул", "дээр", "доор", "руу", "рүү",
  "the", "and", "for", "with", "that", "this", "our", "are", "is",
]);
const SENTENCE_WORDS = 20; // transcripts have no punctuation, so long runs are cut into pieces

export interface Sentence {
  id: number;
  text: string;
}

export interface PointResult {
  point: number;
  text: string;
  status: Status;
  verified: boolean;
  evidence: string;
  note: string;
}

export interface MainPoints {
  method: "llm" | "words";
  points: PointResult[];
  coverage: number | null;
  ideaComment: string;
}

export interface OffTopic {
  sentenceId: number;
  text: string; // quoted by code from the speech, not by the model
  reason: string;
}

function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function terms(text: string): Set<string> {
  return new Set(tokens(text).filter((t) => t.length >= 3 && !STOPWORDS.has(t)).map((t) => t.slice(0, PREFIX)));
}

const squash = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

/** Trimmed, non-empty points, at most MAX_POINTS of at most MAX_POINT_CHARS each. */
export function cleanPoints(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is string => typeof p === "string")
    .map((p) => squash(p).slice(0, MAX_POINT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_POINTS);
}

/** Numbered sentences: split at . ? ! and cut long unpunctuated runs into SENTENCE_WORDS-word pieces. */
export function toSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const part of text.split(/(?<=[.?!…])\s+/)) {
    const words = part.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i += SENTENCE_WORDS) {
      out.push({ id: out.length, text: words.slice(i, i + SENTENCE_WORDS).join(" ") });
    }
  }
  return out;
}

/** No model: the best place each point's key words were said (one sentence or two in a row). */
export function rulesCheck(points: string[], sentences: Sentence[]) {
  const windows = sentences.map((s) => ({ text: s.text, said: terms(s.text) }));
  for (let i = 0; i + 1 < sentences.length; i++) {
    const text = `${sentences[i].text} ${sentences[i + 1].text}`;
    windows.push({ text, said: terms(text) });
  }
  return points.map((point, i) => {
    const want = terms(point);
    let best = 0;
    let quote = "";
    for (const w of windows) {
      if (want.size === 0) break;
      const share = [...want].filter((t) => w.said.has(t)).length / want.size;
      if (share > best) {
        best = share;
        quote = w.text;
      }
    }
    const status: Status = best >= RULES_COVERED ? "covered" : best >= RULES_PARTIAL ? "partial" : "missed";
    return { point: i, status, evidence: status === "missed" ? "" : quote, note: "" };
  });
}

/** A quote without the "[3]" sentence numbers the prompt shows; models often copy them along. */
export function cleanQuote(quote: unknown): string {
  return squash(typeof quote === "string" ? quote.replace(/\[\d+\]/g, " ") : "");
}

/** The text of the sentences a model named by number (at most 2, in speech order); "" when none are valid. */
export function sentenceText(ids: unknown, sentences: Sentence[]): string {
  const list: unknown[] = Array.isArray(ids) ? ids : typeof ids === "number" ? [ids] : [];
  const valid = [...new Set(list)]
    .filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n < sentences.length)
    .sort((a, b) => a - b)
    .slice(0, 2);
  return valid.map((n) => sentences[n].text).join(" ");
}

/** True when `quote` appears word for word in the speech (case and punctuation ignored). */
export function inSpeech(quote: string, sentences: Sentence[]): boolean {
  const words = tokens(quote).join(" ");
  return words !== "" && ` ${tokens(sentences.map((s) => s.text).join(" ")).join(" ")} `.includes(` ${words} `);
}

/** Model (or rules) output -> results the page can trust. */
export function verifyPoints(
  checks: unknown,
  points: string[],
  sentences: Sentence[],
  ideaComment: unknown,
  method: MainPoints["method"],
): MainPoints {
  const transcript = ` ${tokens(sentences.map((s) => s.text).join(" ")).join(" ")} `;
  const byPoint = new Map<number, Record<string, unknown>>();
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!c || typeof c !== "object") continue;
    const idx = (c as Record<string, unknown>).point;
    if (typeof idx === "number" && Number.isInteger(idx) && idx >= 0 && idx < points.length && !byPoint.has(idx)) {
      byPoint.set(idx, c as Record<string, unknown>);
    }
  }

  let total = 0;
  const results: PointResult[] = points.map((text, i) => {
    const c = byPoint.get(i) ?? {};
    const status: Status = STATUSES.includes(c.status as Status) ? (c.status as Status) : "missed";
    // Evidence as sentence numbers (current prompt): the text comes from the speech, so it is real.
    // Otherwise a text quote (rules, older prompt) must appear in the speech word for word.
    const fromIds = sentenceText(c.sentences, sentences);
    const evidence = fromIds || cleanQuote(c.evidence);
    const quoted = tokens(evidence).join(" ");
    const verified = status === "missed" || Boolean(fromIds) || (quoted !== "" && transcript.includes(` ${quoted} `));
    if (verified) total += STATUS_VALUE[status];
    return { point: i, text, status, verified, evidence: verified && status !== "missed" ? evidence : "", note: squash(c.note) };
  });

  return {
    method,
    points: results,
    coverage: points.length ? Math.round((100 * total) / points.length) : null,
    ideaComment: squash(ideaComment),
  };
}

/**
 * The model's off-topic flags -> sentences the page can show. Only real sentence numbers are
 * kept, and the text is quoted by code. Small models flag too much: when an idea or main points
 * are given, a sentence that shares a key word with them is at least related, so its flag is
 * dropped (conservative: may hide a real one).
 */
export function verifyOffTopic(raw: unknown, sentences: Sentence[], idea = "", points: string[] = []): OffTopic[] {
  const related = new Set([idea, ...points].flatMap((x) => [...terms(x)]));
  const seen = new Set<number>();
  const flagged: OffTopic[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const sid = item && typeof item === "object" ? (item as Record<string, unknown>).sentence_id : undefined;
    if (
      typeof sid === "number" &&
      Number.isInteger(sid) &&
      sid >= 0 &&
      sid < sentences.length &&
      !seen.has(sid) &&
      ![...terms(sentences[sid].text)].some((t) => related.has(t))
    ) {
      seen.add(sid);
      const reason = squash((item as Record<string, unknown>).reason);
      // A "reason" that only repeats the sentence says nothing.
      const echo = tokens(reason).join(" ") === tokens(sentences[sid].text).join(" ");
      flagged.push({ sentenceId: sid, text: sentences[sid].text, reason: echo ? "" : reason });
    }
  }
  return flagged.sort((a, b) => a.sentenceId - b.sentenceId);
}
