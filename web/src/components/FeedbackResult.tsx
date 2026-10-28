"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { useLang } from "@/lib/i18nClient";
import { ListenButton, type Improvement, type OffTopic, type Strength } from "./ImprovementList";
import { PitchPointsResult, type MainPointsResult } from "./PitchPoints";
import TtsEngineSelect from "./TtsEngineSelect";

type Panel = "points" | "strengths" | "offTopic";

/**
 * The analysis result, one fix at a time: the summary, a card for the current fix (what to do,
 * the speaker's words, a better way to say it) with back/next, and the main points, strengths and
 * off-topic sentences behind buttons, so the dialog never turns into a wall of text.
 */
export default function FeedbackResult({
  summary,
  strengths,
  improvements,
  offTopic,
  mainPoints,
  pointSlides,
  writing,
  speak,
  hearOwn,
  readAll,
  reading,
}: {
  summary: string;
  strengths: Strength[];
  improvements: Improvement[];
  offTopic: OffTopic[];
  mainPoints: MainPointsResult | null;
  pointSlides: (number | null)[];
  /** True while the model is still writing: the list can still grow, and nothing is read aloud yet. */
  writing: boolean;
  /** The coach voice reading a sentence; absent while the result is being written. */
  speak?: (text: string) => Promise<void>;
  /** Plays a quote from the speaker's own recording, or null when its timing isn't known. */
  hearOwn: (quote: string) => (() => Promise<void>) | null;
  /** Reads the whole result aloud. */
  readAll: () => Promise<void>;
  /** What the read-aloud is on: "summary", "s0" (a strength) or "i2" (a fix). */
  reading: string | null;
}) {
  const { tr } = useLang();
  const id = useId();
  const [index, setIndex] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);

  const total = improvements.length;
  // While the coach voice reads a fix, show that one; otherwise the one the speaker picked.
  const readingFix = reading?.startsWith("i") ? Number(reading.slice(1)) : null;
  const shown = Math.min(readingFix ?? index, Math.max(total - 1, 0));
  const fix = improvements[shown];
  const openPanel: Panel | null = reading?.startsWith("s") ? "strengths" : panel;

  const pointsDone = mainPoints ? mainPoints.points.filter((p) => p.verified && p.status === "covered").length : 0;
  const pointsTotal = mainPoints?.points.length ?? 0;

  function go(to: number) {
    setIndex(Math.max(0, Math.min(total - 1, to)));
  }

  function onCardKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "ArrowLeft") go(shown - 1);
    else if (event.key === "ArrowRight") go(shown + 1);
  }

  function toggle(next: Panel) {
    setPanel((open) => (open === next ? null : next));
  }

  const own = fix?.quote ? hearOwn(fix.quote) : null;

  return (
    <div className="fb">
      <div className="fb-head">
        <p className={reading === "summary" ? "fb-summary desk-reading" : "fb-summary"}>{summary}</p>
        {(pointsTotal > 0 || strengths.length > 0 || offTopic.length > 0) && (
          <div className="fb-badges">
            {pointsTotal > 0 && (
              <button type="button" className="fb-badge" aria-expanded={openPanel === "points"} aria-controls={`${id}-points`} onClick={() => toggle("points")}>
                {tr("pointsChip")} <strong>{pointsDone}/{pointsTotal}</strong>
              </button>
            )}
            {strengths.length > 0 && (
              <button type="button" className="fb-badge" aria-expanded={openPanel === "strengths"} aria-controls={`${id}-strengths`} onClick={() => toggle("strengths")}>
                {tr("strengths")} <strong className="is-positive">{strengths.length}</strong>
              </button>
            )}
            {offTopic.length > 0 && (
              <button type="button" className="fb-badge" aria-expanded={openPanel === "offTopic"} aria-controls={`${id}-offtopic`} onClick={() => toggle("offTopic")}>
                {tr("offTopic")} <strong className="is-warning">{offTopic.length}</strong>
              </button>
            )}
          </div>
        )}
      </div>

      {openPanel === "points" && mainPoints && (
        <div id={`${id}-points`} className="fb-panel">
          <PitchPointsResult result={mainPoints} slides={pointSlides} />
        </div>
      )}
      {openPanel === "strengths" && (
        <ul id={`${id}-strengths`} className="fb-panel fb-strengths">
          {strengths.map((s, i) => {
            const mine = s.quote ? hearOwn(s.quote) : null;
            return (
              <li key={i} className={reading === `s${i}` ? "desk-reading" : undefined}>
                <strong>{s.text}</strong>
                {s.quote && <q>{s.quote}</q>}
                {mine && <ListenButton label={tr("listenYours")} play={mine} />}
              </li>
            );
          })}
        </ul>
      )}
      {openPanel === "offTopic" && (
        <ul id={`${id}-offtopic`} className="fb-panel fb-offtopic">
          {offTopic.map((o) => (
            <li key={o.sentenceId}>
              <q>{o.text}</q>
              {o.reason && <span>{o.reason}</span>}
            </li>
          ))}
        </ul>
      )}

      {fix ? (
        <section
          className={reading === `i${shown}` ? "fb-card desk-reading" : "fb-card"}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-count`}
          onKeyDown={onCardKey}
        >
          <div className="fb-card-top">
            <div className="fb-progress">
              <span className="fb-count" id={`${id}-count`}>
                {tr("fixOf", { n: shown + 1, total })}
                {writing ? " …" : ""}
              </span>
              {total > 1 && (
                <div className="fb-steps">
                  {improvements.map((item, i) => (
                    <button
                      key={i}
                      type="button"
                      className="fb-step"
                      aria-label={`${tr("fixOf", { n: i + 1, total })}: ${item.title}`}
                      aria-current={i === shown ? "step" : undefined}
                      data-state={i === shown ? "current" : i < shown ? "done" : "next"}
                      onClick={() => go(i)}
                    >
                      <span aria-hidden="true" />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {total > 1 && (
              <div className="fb-nav">
                <button type="button" aria-label={tr("prevFix")} disabled={shown === 0} onClick={() => go(shown - 1)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M15 6l-6 6 6 6" />
                  </svg>
                </button>
                <button type="button" aria-label={tr("nextFix")} disabled={shown >= total - 1} onClick={() => go(shown + 1)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M9 6l6 6-6 6" />
                  </svg>
                </button>
              </div>
            )}
          </div>

          <div className="fb-what">
            <h3 id={`${id}-title`}>
              {fix.title}
              {fix.category && <span className="desk-tag">{fix.category}</span>}
              {fix.source === "measured" && <span className="desk-tag">{tr("measuredTag")}</span>}
            </h3>
            {fix.why && <p className="fb-why">{fix.why}</p>}
          </div>

          {fix.action && (
            <p className="fb-action">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
              <span>{fix.action}</span>
            </p>
          )}

          {(fix.quote || fix.example) && (
            <div className="fb-compare">
              {fix.quote && (
                <div className="fb-said">
                  <span className="fb-label">{tr("youSaid")}</span>
                  <q>{fix.quote}</q>
                  {own && <ListenButton label={tr("listenYours")} play={own} />}
                </div>
              )}
              {fix.example && (
                <div className="fb-try">
                  <span className="fb-label">{tr("trySaying")}</span>
                  <span className="fb-example">«{fix.example}»</span>
                  {speak && <ListenButton label={tr("listenExample")} play={() => speak(fix.example)} />}
                </div>
              )}
            </div>
          )}
        </section>
      ) : (
        <section className="fb-card fb-card-empty">
          <p>{writing ? tr("writingFixes") : tr("noFixes")}</p>
        </section>
      )}

      {!writing && (summary || total > 0) && (
        <div className="fb-listen">
          <ListenButton label={tr("listenAllShort")} play={readAll} primary />
          <TtsEngineSelect />
        </div>
      )}
    </div>
  );
}
