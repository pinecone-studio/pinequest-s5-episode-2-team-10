"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import type { Stage } from "@/lib/types";

/** Where an analysis is: sending its files, then the backend's own stages. */
export type AnalysisStep = "upload" | Stage;

const STEPS: { step: AnalysisStep; label: MessageKey }[] = [
  { step: "upload", label: "stageUpload" },
  { step: "transcribing", label: "stageTranscribing" },
  { step: "measuring", label: "stageMeasuring" },
  { step: "slides", label: "stageSlides" },
  { step: "feedback", label: "stageFeedback" },
  { step: "scoring", label: "stageScoring" },
];

/**
 * One compact line that never changes height (it sits in the sticky Analyze footer): the current
 * step, how long it has been running, and a bar with one segment per step.
 */
export default function AnalysisProgress({ step }: { step: AnalysisStep }) {
  const { tr } = useLang();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const current = Math.max(0, STEPS.findIndex((s) => s.step === step));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  return (
    <div className="analysis-progress" role="status" aria-live="polite">
      <div className="analysis-progress-head">
        <span className="analysis-spinner" aria-hidden="true" />
        <span className="analysis-progress-label">
          {tr(STEPS[current].label)}
          <span className="sr-only"> ({tr("stageCount", { n: current + 1, total: STEPS.length })})</span>
        </span>
        <span className="analysis-progress-time" aria-label={tr("stageElapsed", { time: clock })}>
          {clock}
        </span>
      </div>
      <div className="analysis-progress-bar" aria-hidden="true">
        {STEPS.map((s, i) => (
          <span key={s.step} className={i < current ? "is-done" : i === current ? "is-current" : undefined} />
        ))}
      </div>
    </div>
  );
}
