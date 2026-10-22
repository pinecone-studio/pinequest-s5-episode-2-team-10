"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import AudioInput, { type AudioValue } from "@/components/AudioInput";
import ModelPicker from "@/components/ModelPicker";
import { api, saveToken, USING_MOCK } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { DEFAULT_MODEL, MODEL_OPTIONS } from "@/lib/models";
import type { FeedbackBackend, PitchType } from "@/lib/types";

const MODEL_KEY = "pitchcoach:model";
const MAX_SLIDES_BYTES = 20 * 1024 * 1024;

const noSubscribe = () => () => {};

function readSavedModel(): FeedbackBackend {
  try {
    const saved = localStorage.getItem(MODEL_KEY);
    const match = MODEL_OPTIONS.find((m) => m.id === saved);
    if (match) return match.id;
  } catch {}
  return DEFAULT_MODEL;
}

const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-100";

export default function NewSessionPage() {
  const router = useRouter();

  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [plannedMin, setPlannedMin] = useState(3);
  const [pitchType, setPitchType] = useState<PitchType>("startup");
  const [groupId, setGroupId] = useState("");
  const [slides, setSlides] = useState<File | null>(null);
  const [audio, setAudio] = useState<AudioValue | null>(null);
  // Default to the last model picked on this browser.
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
    if (!file) return setSlides(null);
    if (!/\.(pdf|pptx)$/i.test(file.name)) return setError("Slides must be a PDF or PPTX file.");
    if (file.size > MAX_SLIDES_BYTES) return setError("Slides file is larger than 20 MB.");
    setSlides(file);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!audio) return setError("Add audio by uploading a file or recording.");
    setError(null);

    try {
      setStep("Creating session…");
      const { id, access_token } = await api.createSession({
        title: title.trim() || "Untitled pitch",
        goal: goal.trim(),
        audience: audience.trim(),
        planned_s: plannedMin * 60,
        pitch_type: pitchType,
        group_id: groupId.trim() || null,
      });
      saveToken(id, access_token);

      if (slides) {
        setStep("Uploading slides…");
        await api.uploadSlides(id, slides);
      }

      setStep("Uploading audio…");
      await api.uploadAudio(id, audio.blob, audio.filename);

      setStep("Starting analysis…");
      await api.analyze(id, model);

      router.push(`/sessions/${id}`);
    } catch (err) {
      setError(errorMessage(err));
      setStep(null);
    }
  }

  const busy = step !== null;

  return (
    <main className="mx-auto w-full max-w-2xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">AI Pitch Coach</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Upload your slides and a Mongolian recording of your pitch. You get a 0–100 score and
          timestamped advice in about a minute.
        </p>
        {USING_MOCK && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            Demo mode: no backend configured, so results are sample data. Set NEXT_PUBLIC_API_URL to
            use the FastAPI server.
          </p>
        )}
      </header>

      <form onSubmit={submit} className="space-y-8">
        <Section title="1. About the pitch">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Title" className="sm:col-span-2">
              <input className={inputClass} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Hackathon final pitch" />
            </Field>
            <Field label="Goal">
              <input className={inputClass} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="Win seed funding" />
            </Field>
            <Field label="Audience">
              <input className={inputClass} value={audience} onChange={(e) => setAudience(e.target.value)} placeholder="Judges, investors" />
            </Field>
            <Field label="Planned length">
              <select className={inputClass} value={plannedMin} onChange={(e) => setPlannedMin(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((m) => (
                  <option key={m} value={m}>{m} min</option>
                ))}
              </select>
            </Field>
            <Field label="Pitch type">
              <select className={inputClass} value={pitchType} onChange={(e) => setPitchType(e.target.value as PitchType)}>
                <option value="startup">Startup pitch</option>
                <option value="academic">Academic talk</option>
              </select>
            </Field>
            <Field label="Group ID (optional)" hint="Use the same ID for repeat tries of one pitch to compare them." className="sm:col-span-2">
              <input className={inputClass} value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="e.g. team10-final" />
            </Field>
          </div>
        </Section>

        <Section title="2. Slides" hint="Optional. PDF or PPTX, up to 20 MB and 40 slides.">
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-dashed border-zinc-300 px-4 py-4 text-sm hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900">
            <span className={slides ? "font-medium" : "text-zinc-500"}>
              {slides ? slides.name : "Choose a slides file"}
            </span>
            <span className="text-zinc-500 underline">{slides ? "Change" : "Browse"}</span>
            <input type="file" accept=".pdf,.pptx" className="sr-only" onChange={(e) => chooseSlides(e.target.files?.[0])} />
          </label>
          {slides && (
            <button type="button" className="mt-2 text-xs text-zinc-500 underline" onClick={() => setSlides(null)}>
              Remove slides
            </button>
          )}
        </Section>

        <Section title="3. Audio">
          <AudioInput value={audio} onChange={setAudio} />
        </Section>

        <Section title="4. Feedback model" hint="Measurements and scores are computed the same way for every model.">
          <ModelPicker value={model} onChange={chooseModel} />
        </Section>

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

        <button
          type="submit"
          disabled={busy || !audio}
          className="w-full rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {step ?? "Analyze pitch"}
        </button>
      </form>
    </main>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="font-medium">{title}</h2>
      {hint && <p className="mb-3 mt-0.5 text-sm text-zinc-500">{hint}</p>}
      <div className={hint ? "" : "mt-3"}>{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  className = "",
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`block space-y-1 ${className}`}>
      <span className="text-sm text-zinc-700 dark:text-zinc-300">{label}</span>
      {children}
      {hint && <span className="block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}
