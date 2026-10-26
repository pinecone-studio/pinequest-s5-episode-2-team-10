// Records the microphone in sentence-sized pieces and sends each to /api/transcribe
// (the local voice server). Replaces the browser's SpeechRecognition, which has no Mongolian.

import type { WordTime } from "./coachVoice";
import { t } from "./i18n";
import { currentLang, langHeaders } from "./i18nClient";

export interface TranscribeReply {
  text: string;
  words: WordTime[]; // estimated start and end of each word, for playing back a quote
  durationS: number;
  elapsedS: number;
}

// Short pieces lose context and the model starts guessing, so a piece ends at a pause
// only once it is a few seconds long. The whole take is transcribed again on stop.
const PAUSE_MS = 600; // a pause this long ends a piece…
const MIN_PIECE_MS = 4000; // …once the piece is at least this long
const MAX_PIECE_MS = 20000;
const TICK_MS = 100;

export function recorderMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

export function extensionFor(mime: string): string {
  if (mime.includes("ogg")) return "ogg";
  if (mime.includes("mp4")) return "m4a";
  return "webm";
}

export async function transcribeBlob(blob: Blob, name: string): Promise<TranscribeReply> {
  const form = new FormData();
  form.set("file", blob, name);
  let res: Response;
  try {
    res = await fetch("/api/transcribe", { method: "POST", body: form, headers: langHeaders() });
  } catch {
    throw new Error(t(currentLang(), "serverUnreachable"));
  }
  const body = (await res.json().catch(() => null)) as {
    text?: unknown;
    words?: unknown;
    durationS?: unknown;
    elapsedS?: unknown;
    error?: unknown;
  } | null;
  if (!res.ok || !body || typeof body.text !== "string") {
    throw new Error(typeof body?.error === "string" ? body.error : t(currentLang(), "sttFail"));
  }
  const words = Array.isArray(body.words)
    ? (body.words as Partial<WordTime>[]).filter(
        (w): w is WordTime => typeof w?.word === "string" && typeof w.start === "number" && typeof w.end === "number",
      )
    : [];
  return {
    text: body.text,
    words,
    durationS: typeof body.durationS === "number" ? body.durationS : 0,
    elapsedS: typeof body.elapsedS === "number" ? body.elapsedS : 0,
  };
}

/** Root-mean-square level of what the analyser hears right now (0..1). */
export function levelOf(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

export class PieceRecorder {
  private readonly mime = recorderMime();
  private full: MediaRecorder | null = null;
  private fullChunks: Blob[] = [];
  private piece: MediaRecorder | null = null;
  private pieceChunks: Blob[] = [];
  private pieceStart = 0;
  private heard = false;
  private lastVoice = 0;
  private floor = 1;
  private timer = 0;
  private readonly buf: Float32Array<ArrayBuffer>;

  constructor(
    private readonly stream: MediaStream,
    private readonly analyser: AnalyserNode,
    private readonly onPiece: (blob: Blob, name: string) => void,
  ) {
    this.buf = new Float32Array(analyser.fftSize);
  }

  get extension() {
    return extensionFor(this.mime);
  }

  start() {
    this.full = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    this.fullChunks = [];
    this.full.ondataavailable = (e) => e.data.size && this.fullChunks.push(e.data);
    this.full.start(1000);
    this.startPiece();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  /** Stops recording; sends the last piece and returns the whole take. */
  stop(): Promise<Blob | null> {
    window.clearInterval(this.timer);
    this.endPiece(false);
    const full = this.full;
    this.full = null;
    if (!full || full.state === "inactive") return Promise.resolve(null);
    return new Promise((resolve) => {
      full.onstop = () =>
        resolve(this.fullChunks.length ? new Blob(this.fullChunks, { type: full.mimeType || this.mime }) : null);
      full.stop();
    });
  }

  private startPiece() {
    const rec = new MediaRecorder(this.stream, this.mime ? { mimeType: this.mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.start();
    this.piece = rec;
    this.pieceChunks = chunks;
    this.pieceStart = performance.now();
    this.heard = false;
  }

  /** Ends the current piece, sends it if it had speech, and optionally starts the next one. */
  private endPiece(next: boolean) {
    const rec = this.piece;
    const chunks = this.pieceChunks;
    const heard = this.heard;
    this.piece = null;
    if (next) this.startPiece();
    if (!rec || rec.state === "inactive") return;
    rec.onstop = () => {
      if (heard && chunks.length) {
        this.onPiece(new Blob(chunks, { type: rec.mimeType || this.mime }), `piece.${this.extension}`);
      }
    };
    rec.stop();
  }

  private tick() {
    const now = performance.now();
    const level = levelOf(this.analyser, this.buf);
    // Track the background level: follow it down at once, drift up slowly.
    this.floor = level < this.floor ? level : this.floor * 1.002 + 1e-6;
    const speaking = level > Math.max(0.01, this.floor * 3);
    if (speaking) {
      this.heard = true;
      this.lastVoice = now;
    }
    const length = now - this.pieceStart;
    const quiet = now - this.lastVoice;
    if ((this.heard && quiet >= PAUSE_MS && length >= MIN_PIECE_MS) || length >= MAX_PIECE_MS) {
      this.endPiece(true);
    }
  }
}
