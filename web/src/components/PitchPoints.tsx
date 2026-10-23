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

/** The pitch idea and up to MAX_POINTS main points the speech should get across. */
export function PitchPointsEditor({
  idea,
  points,
  onChange,
}: {
  idea: string;
  points: string[];
  onChange: (next: { idea: string; points: string[] }) => void;
}) {
  const { tr } = useLang();
  const id = useId();
  const rows = points.length ? points : [""];

  function setPoint(i: number, value: string) {
    onChange({ idea, points: rows.map((p, j) => (j === i ? value : p)) });
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
          onChange={(e) => onChange({ idea: e.target.value, points })}
        />
      </label>
      <fieldset className="desk-points-field">
        <legend>{tr("mainPoints")}</legend>
        <ol>
          {rows.map((p, i) => (
            <li key={i}>
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
                  onClick={() => onChange({ idea, points: rows.filter((_, j) => j !== i) })}
                >
                  {tr("removePoint")}
                </button>
              )}
            </li>
          ))}
        </ol>
        {rows.length < MAX_POINTS && (
          <button type="button" className="desk-ghost" onClick={() => onChange({ idea, points: [...rows, ""] })}>
            {tr("addPoint")}
          </button>
        )}
      </fieldset>
    </section>
  );
}

/** Per-point results from "send to model": status, the verified quote, and off-topic sentences. */
export function PitchPointsResult({ result }: { result: MainPointsResult }) {
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
