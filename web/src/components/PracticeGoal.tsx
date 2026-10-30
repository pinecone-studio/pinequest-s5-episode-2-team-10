"use client";

import { useEffect, useRef, useState } from "react";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { canDrill, checkDrill, DRILL_FILLERS, FILLER_GOAL, nextGoal, type DrillResult, type Goal } from "@/lib/practiceGoal";
import type { Take } from "@/lib/takes";
import { extensionFor, recorderMime, transcribeBlob } from "@/lib/voiceRecorder";

const MAX_DRILL_S = 60;
const HEARD_WORDS = 30;

type Drill =
  | { step: "idle" }
  | { step: "recording"; seconds: number }
  | { step: "checking" }
  | { step: "done"; result: DrillResult; heard: string }
  | { step: "error"; message: string };

/** What to work on next, as one sentence, plus how to practise it. */
function describe(goal: Goal): { text: MessageKey; vars: Record<string, string | number>; hint: MessageKey; hintText?: string } {
  switch (goal.kind) {
    case "point":
      return { text: goal.status === "missed" ? "goalPointMissed" : "goalPointPartial", vars: { point: goal.point }, hint: "goalPointHint" };
    case "number":
      return { text: goal.said ? "goalNumberSaid" : "goalNumber", vars: { slide: goal.onSlide, said: goal.said ?? "" }, hint: "goalFullTake" };
    case "fillers":
      return { text: "goalFillers", vars: { per100: goal.per100.toFixed(1), limit: FILLER_GOAL }, hint: goal.words.length ? "goalFillersHint" : "goalFullTake" };
    case "pauses":
      return { text: "goalPauses", vars: { perMin: goal.perMin.toFixed(1) }, hint: "goalPausesHint" };
    case "fix":
      // The analysis's own "what to do", when it gave one.
      return { text: "goalFix", vars: { problem: goal.problem }, hint: "goalFullTake", hintText: goal.action || undefined };
    case "ready":
      return { text: "goalReady", vars: {}, hint: "goalReadyHint" };
  }
}

/** The goal for the next take, with a short drill that checks only that goal. Nothing is saved. */
export default function PracticeGoal({ take }: { take: Take }) {
  const { tr } = useLang();
  const goal = nextGoal(take);
  const goalKey = JSON.stringify(goal);
  const { text, vars, hint, hintText } = describe(goal);

  const [drill, setDrill] = useState<{ goal: string; state: Drill }>({ goal: goalKey, state: { step: "idle" } });
  const state: Drill = drill.goal === goalKey ? drill.state : { step: "idle" }; // a new goal starts fresh
  const set = (next: Drill) => setDrill({ goal: goalKey, state: next });

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);

  const release = () => {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  };
  // Leaving the page mid-drill: stop the microphone without checking the half-finished recording.
  useEffect(
    () => () => {
      const rec = recorder.current;
      if (rec?.state === "recording") {
        rec.onstop = null;
        rec.stop();
      }
      if (timer.current != null) window.clearInterval(timer.current);
      stream.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  async function start() {
    if (!canDrill(goal)) return;
    const drillGoal = goal;
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      set({ step: "error", message: tr("drillMicError") });
      return;
    }
    const mime = recorderMime();
    const rec = new MediaRecorder(stream.current, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      release();
      set({ step: "checking" });
      try {
        const blob = new Blob(chunks, { type: rec.mimeType || mime || "audio/webm" });
        const reply = await transcribeBlob(blob, `drill.${extensionFor(rec.mimeType || mime)}`);
        const words = reply.text.split(/\s+/).filter(Boolean);
        const heard = words.length > HEARD_WORDS ? `${words.slice(0, HEARD_WORDS).join(" ")} …` : reply.text;
        set({ step: "done", result: checkDrill(drillGoal, reply.text, reply.words), heard });
      } catch (err) {
        set({ step: "error", message: err instanceof Error && err.message ? err.message : tr("sttFail") });
      }
    };
    recorder.current = rec;
    rec.start();
    let seconds = 0;
    set({ step: "recording", seconds });
    timer.current = window.setInterval(() => {
      seconds += 1;
      if (seconds >= MAX_DRILL_S) stop();
      else set({ step: "recording", seconds });
    }, 1000);
  }

  function stop() {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
    if (recorder.current?.state === "recording") recorder.current.stop();
  }

  const drillable = canDrill(goal);
  return (
    <div className={`take-goal${goal.kind === "ready" ? " is-ready" : ""}`}>
      <h3>{tr("goalTitle")}</h3>
      <p className="take-goal-text">{tr(text, vars)}</p>
      <p className="take-note">{hintText ?? tr(hint, { limit: DRILL_FILLERS })}</p>

      {drillable && (
        <div className="take-drill">
          {state.step === "recording" ? (
            <button type="button" className="room-glass-btn is-live" onClick={stop}>
              {tr("drillStop")} · {state.seconds}s
            </button>
          ) : (
            <button type="button" className="room-glass-btn" disabled={state.step === "checking"} onClick={() => void start()}>
              {state.step === "done" || state.step === "error" ? tr("drillAgain") : tr("drillStart")}
            </button>
          )}
          <div aria-live="polite">
            {state.step === "recording" && <p className="take-note">{tr("drillRecording")}</p>}
            {state.step === "checking" && <p className="take-note">{tr("drillChecking")}</p>}
            {state.step === "error" && <p className="take-drill-result is-fail">{state.message}</p>}
            {state.step === "done" && (
              <>
                <p className={`take-drill-result is-${state.result.verdict}`}>
                  {tr(state.result.key, state.result.vars)}
                  {state.result.verdict === "pass" && ` ${tr("drillNextTake")}`}
                </p>
                {state.heard && (
                  <p className="take-note">
                    {tr("drillHeard")} <q>{state.heard}</q>
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
