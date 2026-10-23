"use client";

import { useId } from "react";
import { useLang } from "@/lib/i18nClient";

export const MAX_POINTS = 6;

export interface MainPointsResult {
  method: "llm" | "words";
  points: { point: number; text: string; status: "covered" | "partial" | "missed"; verified: boolean; evidence: string; note: string }[];
  coverage: number | null;
  ideaComment: string;
}

/**
 * The points a check is sent with: non-empty, at most MAX_POINTS, each with its slide. The reply
 * numbers points in this order, so keep `slides` to label the results.
 */
export function pointsToSend(points: string[] = [], slides: (number | null)[] = []) {
  const sent = points
    .map((text, i) => ({ text: text.trim(), slide: slides[i] ?? null }))
    .filter((p) => p.text)
    .slice(0, MAX_POINTS);
  return { texts: sent.map((p) => p.text), slides: sent.map((p) => p.slide) };
}

/** Options for a point's slide picker when the deck's length is unknown (a Figma-only folder). */
const UNKNOWN_DECK_SLIDES = 20;

/**
 * The first slide after `after` that isn't a transition, or `after` itself when none is left.
 * With no slide to start from, the first content slide.
 */
function nextContentSlide(after: number | null, last: number, transitions: number[]): number | null {
  for (let n = (after ?? 0) + 1; n <= last; n++) if (!transitions.includes(n)) return n;
  return after ?? null;
}

/**
 * The pitch idea and up to MAX_POINTS main points the speech should get across, each tied to the
 * slide it belongs to. `slides[i]` is point i's slide number (as on screen), or null for none.
 * A new point goes on the slide after the previous point's, skipping transition slides.
 */
export function PitchPointsEditor({
  idea,
  points,
  slides,
  slideCount,
  currentSlide,
  transitions,
  onChange,
}: {
  idea: string;
  points: string[];
  slides: (number | null)[];
  /** Slides in the deck, or 0 when unknown. */
  slideCount: number;
  /** The slide on screen; the first point starts on it. */
  currentSlide: number | null;
  /** Slides with hardly any text (titles, section dividers); new points skip them. */
  transitions: number[];
  onChange: (next: { idea: string; points: string[]; slides: (number | null)[] }) => void;
}) {
  const { tr } = useLang();
  const id = useId();
  const rows = points.length ? points : [""];
  const highestSaved = Math.max(0, ...slides.map((n) => n ?? 0));
  const last = Math.max(slideCount || UNKNOWN_DECK_SLIDES, highestSaved);
  // The first empty row starts on the slide on screen (or the next content slide after a title);
  // points saved before slides existed have none.
  const firstSlide =
    currentSlide !== null && !transitions.includes(currentSlide)
      ? currentSlide
      : nextContentSlide(currentSlide !== null ? currentSlide : 0, last, transitions) ?? currentSlide;
  const rowSlides = rows.map((_, i) => (i < slides.length ? slides[i] : points.length ? null : firstSlide));
  const options = Array.from({ length: last }, (_, i) => i + 1);
  const previous = rowSlides.findLast((n) => n !== null) ?? null;
  const nextSlide = previous === null ? firstSlide : nextContentSlide(previous, last, transitions);

  function emit(nextPoints: string[], nextSlides: (number | null)[], nextIdea = idea) {
    onChange({ idea: nextIdea, points: nextPoints, slides: nextSlides });
  }

  function setPoint(i: number, value: string) {
    emit(rows.map((p, j) => (j === i ? value : p)), rowSlides);
  }

  function setSlide(i: number, value: string) {
    emit(rows, rowSlides.map((n, j) => (j === i ? (value ? Number(value) : null) : n)));
  }

  return (
    <section className="desk-points" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{tr("pitchSetup")}</h2>
      <p className="desk-sub">{tr("pointsHint")}</p>
      <label className="desk-points-field">
        <span>{tr("pitchIdea")}</span>
        <textarea
          className="desk-field"
          rows={2}
          maxLength={500}
          value={idea}
          placeholder={tr("pitchIdeaHint")}
          onChange={(e) => emit(points, slides, e.target.value)}
        />
      </label>
      <fieldset className="desk-points-field">
        <legend>{tr("mainPoints")}</legend>
        <ol>
          {rows.map((p, i) => (
            <li key={i}>
              <select
                className="desk-field desk-point-slide"
                value={rowSlides[i] ?? ""}
                aria-label={`${tr("mainPoints")} ${i + 1}: ${tr("slide")}`}
                onChange={(e) => setSlide(i, e.target.value)}
              >
                <option value="">—</option>
                {options.map((n) => (
                  <option key={n} value={n}>
                    {tr("slide")} {n}
                    {transitions.includes(n) ? ` · ${tr("slideTransition")}` : ""}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="desk-field"
                maxLength={200}
                value={p}
                aria-label={`${tr("mainPoints")} ${i + 1}`}
                placeholder={i === 0 ? tr("pointPlaceholder") : ""}
                onChange={(e) => setPoint(i, e.target.value)}
              />
              {rows.length > 1 && (
                <button
                  type="button"
                  className="desk-link"
                  aria-label={`${tr("removePoint")} ${i + 1}`}
                  onClick={() => emit(rows.filter((_, j) => j !== i), rowSlides.filter((_, j) => j !== i))}
                >
                  {tr("removePoint")}
                </button>
              )}
            </li>
          ))}
        </ol>
        {rows.length < MAX_POINTS && (
          <button type="button" className="desk-ghost" onClick={() => emit([...rows, ""], [...rowSlides, nextSlide])}>
            {tr("addPoint")}
          </button>
        )}
      </fieldset>
    </section>
  );
}

/** Per-point results from "send to model": status, the verified quote, and off-topic sentences. */
export function PitchPointsResult({ result, slides = [] }: { result: MainPointsResult; slides?: (number | null)[] }) {
  const { tr } = useLang();
  const label = { covered: tr("statusCovered"), partial: tr("statusPartial"), missed: tr("statusMissed") };
  return (
    <div className="desk-points-result">
      {result.coverage !== null && <h3>{tr("coverage", { pct: result.coverage })}</h3>}
      {result.method === "words" && <p className="desk-sub">{tr("methodWords")}</p>}
      {result.ideaComment && <p>{result.ideaComment}</p>}
      <ul>
        {result.points.map((p) => {
          const shown = p.verified ? p.status : "missed";
          return (
            <li key={p.point}>
              <span className={`desk-chip is-${shown}`}>{label[shown]}</span>
              {slides[p.point] != null && (
                <span className="desk-point-slide-tag">
                  {tr("slide")} {slides[p.point]}
                </span>
              )}
              <strong>{p.text}</strong>
              {p.evidence && <q>{p.evidence}</q>}
              {!p.verified && <em>{tr("unverified")}</em>}
              {p.note && <span>{p.note}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
