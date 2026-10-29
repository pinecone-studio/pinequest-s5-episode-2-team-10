"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import type { Stage } from "@/lib/types";

/** Where an analysis is: uploading, waiting for its turn, then the backend's own stages. */
export type AnalysisStep = "upload" | "queued" | Stage;

const STEPS: { step: AnalysisStep; label: MessageKey }[] = [
  { step: "upload", label: "stageUpload" },
  { step: "queued", label: "stageQueued" },
  { step: "transcribing", label: "stageTranscribing" },
  { step: "measuring", label: "stageMeasuring" },
  { step: "slides", label: "stageSlides" },
  { step: "feedback", label: "stageFeedback" },
  { step: "scoring", label: "stageScoring" },
];

/** A step list with the current one marked, and how long it has been running. */
export default function AnalysisProgress({ step, queuePosition }: { step: AnalysisStep; queuePosition: number | null }) {
  const { tr } = useLang();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const current = STEPS.findIndex((s) => s.step === step);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="analysis-progress" role="status" aria-live="polite">
      <div className="analysis-progress-head">
        <strong>{tr(STEPS[current]?.label ?? "stageUpload")}</strong>
        <span className="analysis-progress-time" aria-label={tr("stageElapsed", { time: clock })}>
          {clock}
        </span>
      </div>
      <ol>
        {STEPS.map((s, i) => (
          <li key={s.step} className={i < current ? "is-done" : i === current ? "is-current" : undefined} aria-current={i === current ? "step" : undefined}>
            <span className="analysis-progress-dot" aria-hidden="true">{i < current ? "✓" : ""}</span>
            {tr(s.label)}
            {i === current && s.step === "queued" && queuePosition ? <small> · {tr("stageQueuePosition", { n: queuePosition })}</small> : null}
          </li>
        ))}
      </ol>
      {step === "feedback" && <p className="analysis-progress-hint">{tr("stageFeedbackHint")}</p>}
    </div>
  );
}
