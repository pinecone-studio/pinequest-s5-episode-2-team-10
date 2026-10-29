"use client";

import { useEffect, useState } from "react";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import type { Stage } from "@/lib/types";

/** Where an analysis is: sending its files, then the backend's own stages. */
export type AnalysisStep = "upload" | Stage;

// Each step's share of the ring is how long it usually takes (seconds, with Gemma on the GPU PC).
const STEPS: { step: AnalysisStep; label: MessageKey; usual: number }[] = [
  { step: "upload", label: "stageUpload", usual: 5 },
  { step: "transcribing", label: "stageTranscribing", usual: 12 },
  { step: "measuring", label: "stageMeasuring", usual: 4 },
  { step: "slides", label: "stageSlides", usual: 3 },
  { step: "feedback", label: "stageFeedback", usual: 35 },
  { step: "scoring", label: "stageScoring", usual: 3 },
];
const TOTAL = STEPS.reduce((sum, s) => sum + s.usual, 0);
const R = 7;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * A ring that fills as the analysis goes: up to where the current step starts, then onward while it
 * runs (never past 95% of the step's share, so it doesn't look done before it is). Remounted for each
 * step (key), so its own second counter starts at 0.
 */
function Ring({ index }: { index: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const before = STEPS.slice(0, index).reduce((sum, s) => sum + s.usual, 0);
  const share = STEPS[index].usual;
  const filled = (before + Math.min(0.95, seconds / share) * share) / TOTAL;
  return (
    <svg className="analysis-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle className="analysis-ring-track" cx="9" cy="9" r={R} />
      <circle
        className="analysis-ring-fill"
        cx="9"
        cy="9"
        r={R}
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
      />
    </svg>
  );
}

/** One line in the sticky Analyze footer: a filling ring, the current step, and the time so far. */
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
        <Ring key={step} index={current} />
        <span className="analysis-progress-label">
          {tr(STEPS[current].label)}
          <span className="sr-only"> ({tr("stageCount", { n: current + 1, total: STEPS.length })})</span>
        </span>
        <span className="analysis-progress-time" aria-label={tr("stageElapsed", { time: clock })}>
          {clock}
        </span>
      </div>
    </div>
  );
}
