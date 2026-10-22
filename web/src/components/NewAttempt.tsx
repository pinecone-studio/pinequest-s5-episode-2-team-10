"use client";

import { useState, useSyncExternalStore } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "@/lib/models";
import type { FeedbackBackend, Project } from "@/lib/types";
import AudioInput, { type AudioValue } from "./AudioInput";
import { Card, inputClass } from "./Field";
import ModelPicker from "./ModelPicker";

const MODEL_KEY = "pitchcoach:model";
const MAX_SLIDES_BYTES = 20 * 1024 * 1024;

const noSubscribe = () => () => {};

function readSavedModel(): FeedbackBackend {
  try {
    const match = MODEL_OPTIONS.find((m) => m.id === localStorage.getItem(MODEL_KEY));
    if (match) return match.id;
  } catch {}
  return DEFAULT_MODEL;
}

// keep: reuse the slides from the last attempt; new: upload this file; none: no slides.
type SlidesChoice = { kind: "keep" } | { kind: "new"; file: File } | { kind: "none" };

export default function NewAttempt({ project, onStarted }: { project: Project; onStarted: (attemptId: string) => void }) {
  const hasPrevSlides = !!project.current.slides_filename;
  const [slides, setSlides] = useState<SlidesChoice>(hasPrevSlides ? { kind: "keep" } : { kind: "none" });
  const [script, setScript] = useState(project.current.script);
  const [audio, setAudio] = useState<AudioValue | null>(null);
  const savedModel = useSyncExternalStore(noSubscribe, readSavedModel, () => DEFAULT_MODEL);
  const [picked, setPicked] = useState<FeedbackBackend | null>(null);
  const model = picked ?? savedModel;

  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function chooseModel(m: FeedbackBackend) {
    setPicked(m);
    try {
      localStorage.setItem(MODEL_KEY, m);
    } catch {}
  }

  function chooseSlides(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!/\.(pdf|pptx)$/i.test(file.name)) return setError("Slides must be a PDF or PPTX file.");
    if (file.size > MAX_SLIDES_BYTES) return setError("Slides file is larger than 20 MB.");
    setSlides({ kind: "new", file });
  }

  async function analyze() {
    if (!audio) return setError("Add a recording by uploading a file or recording.");
    setError(null);
    let attemptId: string | null = null;
    try {
      setStep("Preparing…");
      // The new attempt starts with the last attempt's slides and script.
      const attempt = await api.createAttempt(project.id);
      attemptId = attempt.id;

      if (slides.kind === "new") {
        setStep("Uploading slides…");
        await api.uploadSlides(attempt.id, slides.file);
      } else if (slides.kind === "none" && attempt.slide_count > 0) {
        await api.removeSlides(attempt.id);
      }
      if (script.trim() !== project.current.script.trim()) {
        await api.setScript(attempt.id, script);
      }

      setStep("Uploading audio…");
      await api.uploadAudio(attempt.id, audio.blob, audio.filename);

      setStep("Starting analysis…");
      await api.analyze(attempt.id, model);

      setAudio(null);
      if (slides.kind === "new") setSlides({ kind: "keep" });
      setStep(null);
      onStarted(attempt.id);
    } catch (e) {
      setError(errorMessage(e));
      setStep(null);
      if (attemptId) api.deleteAttempt(attemptId).catch(() => {});
    }
  }

  const busy = step !== null;
  const slidesLabel =
    slides.kind === "new"
      ? slides.file.name
      : slides.kind === "keep"
        ? `${project.current.slides_filename} · ${project.current.slide_count} slides (from last attempt)`
        : null;

  return (
    <Card title={project.attempts.length ? "New attempt" : "Your pitch"} hint="Each analysis is saved as an attempt in this project.">
      <div className="space-y-6">
        <div>
          <h3 className="text-sm font-medium">Slides</h3>
          <p className="mb-2 text-xs text-zinc-500">Optional. PDF or PPTX, up to 20 MB and 40 slides.</p>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            <span className={slidesLabel ? "font-medium" : "text-zinc-500"}>{slidesLabel ?? "Choose a slides file"}</span>
            <span className="shrink-0 text-zinc-500 underline">{slidesLabel ? "Replace" : "Browse"}</span>
            <input
              type="file"
              accept=".pdf,.pptx"
              className="sr-only"
              onChange={(e) => {
                chooseSlides(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <div className="mt-1.5 flex gap-3 text-xs text-zinc-500">
            {slides.kind !== "none" && (
              <button type="button" className="underline" onClick={() => setSlides({ kind: "none" })}>
                Don&apos;t use slides
              </button>
            )}
            {slides.kind !== "keep" && hasPrevSlides && (
              <button type="button" className="underline" onClick={() => setSlides({ kind: "keep" })}>
                Use slides from last attempt
              </button>
            )}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium">Script</h3>
          <p className="mb-2 text-xs text-zinc-500">
            Optional. What you plan to say. The AI points out important parts you skipped or changed.
          </p>
          <textarea
            className={`${inputClass} min-h-28 resize-y`}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            maxLength={20000}
            placeholder="Сайн байна уу, бид…"
          />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Recording</h3>
          <AudioInput value={audio} onChange={setAudio} />
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">Feedback model</h3>
          <ModelPicker value={model} onChange={chooseModel} />
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
        )}

        <button
          type="button"
          onClick={analyze}
          disabled={busy || !audio || project.processing}
          className="w-full rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {step ?? (project.processing ? "Wait for the current analysis…" : "Analyze pitch")}
        </button>
      </div>
    </Card>
  );
}
