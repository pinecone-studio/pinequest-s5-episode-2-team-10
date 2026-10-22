"use client";

import { useLang } from "@/lib/i18nClient";

export interface Improvement {
  source: "measured" | "model"; // measured: found by code; model: the model's advice
  title: string;
  why: string;
  action: string;
  example: string;
  quote: string; // from the speech; empty when the model gave none or made one up
}

export interface Strength {
  text: string;
  quote: string; // the words from the speech that show it
}

export interface OffTopic {
  sentenceId: number;
  text: string;
  reason: string;
}

/** Strengths (each with the words that show it), things to improve, and off-topic sentences. */
export default function ImprovementList({
  strengths,
  improvements,
  offTopic = [],
}: {
  strengths: Strength[];
  improvements: Improvement[];
  offTopic?: OffTopic[];
}) {
  const { tr } = useLang();
  return (
    <div className="desk-improve">
      {strengths.length > 0 && (
        <>
          <h3>{tr("strengths")}</h3>
          <ul className="desk-strengths">
            {strengths.map((s, i) => (
              <li key={i}>
                {s.text}
                {s.quote && <q>{s.quote}</q>}
              </li>
            ))}
          </ul>
        </>
      )}
      {improvements.length > 0 && (
        <>
          <h3>{tr("improvements")}</h3>
          <ol>
            {improvements.map((item, i) => (
              <li key={i}>
                <strong>
                  {item.title}
                  {item.source === "measured" && <span className="desk-tag">{tr("measuredTag")}</span>}
                </strong>
                {item.quote && <q>{item.quote}</q>}
                {item.why && (
                  <span>
                    <em>{tr("improveWhy")}:</em> {item.why}
                  </span>
                )}
                <span>
                  <em>{tr("improveAction")}:</em> {item.action}
                </span>
                {item.example && (
                  <span>
                    <em>{tr("improveExample")}:</em> «{item.example}»
                  </span>
                )}
              </li>
            ))}
          </ol>
        </>
      )}
      {offTopic.length > 0 && (
        <>
          <h3>{tr("offTopic")}</h3>
          <ul className="desk-offtopic">
            {offTopic.map((o) => (
              <li key={o.sentenceId}>
                <q>{o.text}</q>
                {o.reason && <span>{o.reason}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
