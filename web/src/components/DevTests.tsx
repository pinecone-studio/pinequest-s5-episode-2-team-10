"use client";

import { useState } from "react";
import type { ProtoModel } from "@/lib/feedbackModels";
import { t, type MessageKey } from "@/lib/i18n";
import { currentLang, langHeaders, useLang } from "@/lib/i18nClient";
import { matchedWords } from "@/lib/textMatch";
import { extensionFor, levelOf, recorderMime, transcribeBlob } from "@/lib/voiceRecorder";
import { fetchModelStatuses } from "./FeedbackModelSelect";

// Local-only checks for the voice server, the microphone and the feedback models.
// FolderDesk renders this only when NODE_ENV is "development".

interface Result {
  id: number;
  label: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const MIC_SECONDS = 4;
// A 76 s pitch-style recording from Common Voice sentences (CC0), see public/test-audio/README.txt.
const SAMPLE_AUDIO = "/test-audio/mn-sample.webm";
const SAMPLE_TEXT = "/test-audio/mn-sample.txt";
// Sample input for the model check; Mongolian on purpose, since that is what the app analyses.
const SAMPLE_SPEECH =
  "Сайн байна уу, ээ, бид өнөөдөр шинэ төслөө танилцуулна. Оюутнууд илтгэл тавихаас өмнө дадлага хийх боломж бага байдаг байдаг.";

const tr = (key: MessageKey, vars?: Record<string, string | number>) => t(currentLang(), key, vars);

async function voiceStatus(): Promise<string> {
  const res = await fetch("/api/transcribe", { cache: "no-store", headers: langHeaders() });
  const body = (await res.json()) as { ok?: boolean; device?: string; modelLoaded?: boolean; busy?: boolean; error?: string };
  if (!body.ok) throw new Error(body.error ?? tr("voiceDown"));
  return [body.device ?? "?", tr(body.modelLoaded ? "modelLoaded" : "modelNotLoaded"), body.busy ? tr("busy") : ""]
    .filter(Boolean)
    .join(" · ");
}

export async function fetchSample(): Promise<{ audio: Blob; reference: string }> {
  const [audioRes, textRes] = await Promise.all([fetch(SAMPLE_AUDIO), fetch(SAMPLE_TEXT)]);
  if (!audioRes.ok || !textRes.ok) throw new Error(`${SAMPLE_AUDIO}: HTTP ${audioRes.status}`);
  return { audio: await audioRes.blob(), reference: await textRes.text() };
}

async function sampleCheck(): Promise<string> {
  const { audio, reference } = await fetchSample();
  const reply = await transcribeBlob(audio, "mn-sample.webm");
  const { matched, total } = matchedWords(reference, reply.text);
  const pct = total ? Math.round((matched / total) * 100) : 0;
  return [
    tr("sampleScore", { matched, total, pct }),
    tr("sampleTiming", { audio: reply.durationS.toFixed(1), gpu: reply.elapsedS.toFixed(1) }),
    `«${reply.text || tr("noSpeechFound")}»`,
  ].join(" · ");
}

async function micCheck(): Promise<string> {
  const mime = recorderMime();
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    throw new Error(tr("browserNoRecord"));
  }
  const stream = await navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
    .catch(() => {
      throw new Error(tr("micDenied"));
    });
  const ctx = new AudioContext();
  try {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const meter = window.setInterval(() => (peak = Math.max(peak, levelOf(analyser, buf))), 50);

    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.start();
    await new Promise((r) => window.setTimeout(r, MIC_SECONDS * 1000));
    rec.stop();
    await stopped;
    window.clearInterval(meter);

    const blob = new Blob(chunks, { type: rec.mimeType || mime });
    const level = tr("peakLevel", { p: (peak * 100).toFixed(1) }) + (peak < 0.01 ? tr("tooQuiet") : "");
    const reply = await transcribeBlob(blob, `mic-test.${extensionFor(mime)}`);
    return `${level} · ${(blob.size / 1024).toFixed(0)} KB ${rec.mimeType || mime} · «${reply.text || tr("noSpeechFound")}»`;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
    void ctx.close();
  }
}

async function modelList(): Promise<string> {
  const models = await fetchModelStatuses();
  return models.map((m) => `${m.name}: ${m.available ? tr("ready") : (m.reason ?? tr("unavailableTag"))}`).join(" · ");
}

async function modelCheck(model: ProtoModel): Promise<string> {
  const body = new FormData();
  body.set("text", SAMPLE_SPEECH);
  body.set("slideText", "");
  body.set("model", model);
  const res = await fetch("/api/prototype", { method: "POST", body, headers: langHeaders() });
  const payload = (await res.json().catch(() => null)) as { summary?: string; error?: string } | null;
  if (!res.ok || !payload?.summary) throw new Error(payload?.error ?? `HTTP ${res.status}`);
  return payload.summary;
}

// Three points the sample pitch makes and one it never does, so a good check scores about 75%
// and flags sentence 7 (about meat products) as off topic.
const SAMPLE_IDEA = "Монгол орчинд тохирсон дуу хоолойн технологиор ажлын ур чадварын сургалт хийх";
const SAMPLE_POINTS = [
  "Дуу хоолойн технологи хурдан хөгжиж байна",
  "Ажлын ур чадварын сургалт дутмаг байна",
  "Манай компани энэ асуудалд тусгай баг гаргасан",
  "Эхний жилд мянган хэрэглэгчтэй болно",
];

async function pointsCheck(model: ProtoModel): Promise<string> {
  const { reference } = await fetchSample();
  const body = new FormData();
  body.set("text", reference);
  body.set("slideText", "");
  body.set("model", model);
  body.set("idea", SAMPLE_IDEA);
  body.set("keyPoints", JSON.stringify(SAMPLE_POINTS));
  const res = await fetch("/api/prototype", { method: "POST", body, headers: langHeaders() });
  const payload = (await res.json().catch(() => null)) as {
    mainPoints?: { coverage: number | null; points: { status: string; verified: boolean }[]; offTopic: unknown[] } | null;
    error?: string;
  } | null;
  const mp = payload?.mainPoints;
  if (!res.ok || !mp) throw new Error(payload?.error ?? `HTTP ${res.status}`);
  const marks = mp.points.map((p, i) => `${i + 1}:${p.verified ? p.status : `${p.status}?`}`).join(" ");
  return `${tr("coverage", { pct: mp.coverage ?? 0 })} · ${marks} · ${tr("offTopic")}: ${mp.offTopic.length}`;
}

let nextId = 0;

async function timed(label: string, check: () => Promise<string>): Promise<Result> {
  const started = performance.now();
  let ok = true;
  let detail: string;
  try {
    detail = await check();
  } catch (err) {
    ok = false;
    detail = err instanceof Error ? err.message : String(err);
  }
  return { id: ++nextId, label, ok, detail, ms: performance.now() - started };
}

type CheckId = "voice" | "sample" | "loadSample" | "mic" | "models" | "model" | "points";

export default function DevTests({
  model,
  onLoadSample,
}: {
  model: ProtoModel;
  /** Puts the sample into the folder as its audio and transcribes it, like a real recording. */
  onLoadSample: (audio: Blob) => Promise<string>;
}) {
  const { tr: trNow } = useLang();
  const [running, setRunning] = useState<CheckId | null>(null);
  const [results, setResults] = useState<Result[]>([]);

  const checks: { id: CheckId; label: string; run: () => Promise<string> }[] = [
    { id: "voice", label: trNow("testVoiceServer"), run: voiceStatus },
    { id: "sample", label: trNow("testSample"), run: sampleCheck },
    { id: "loadSample", label: trNow("testLoadSample"), run: async () => onLoadSample((await fetchSample()).audio) },
    { id: "mic", label: trNow("testMic", { s: MIC_SECONDS }), run: micCheck },
    { id: "models", label: trNow("testModels"), run: modelList },
    { id: "model", label: trNow("testModel", { m: model }), run: () => modelCheck(model) },
    { id: "points", label: trNow("testPoints"), run: () => pointsCheck(model) },
  ];

  async function run(check: (typeof checks)[number]) {
    setRunning(check.id);
    const entry = await timed(check.label, check.run);
    setResults((prev) => [entry, ...prev].slice(0, 8));
    setRunning(null);
  }

  return (
    <section className="desk-tests" aria-label={trNow("localTests")}>
      <h3>{trNow("localTests")}</h3>
      <p className="desk-sub">{trNow("devOnly")}</p>
      <div className="desk-tests-buttons">
        {checks.map((check) => (
          <button
            key={check.id}
            type="button"
            className="desk-ghost"
            disabled={running !== null}
            onClick={() => void run(check)}
          >
            {running === check.id && check.id === "mic" ? trNow("speakNow") : check.label}
          </button>
        ))}
      </div>
      <ul aria-live="polite">
        {results.map((r) => (
          <li key={r.id} className={r.ok ? "is-ok" : "is-fail"}>
            <strong>
              {r.ok ? "✓" : "✗"} {r.label} · {(r.ms / 1000).toFixed(1)} {trNow("seconds")}
            </strong>
            <span>{r.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
