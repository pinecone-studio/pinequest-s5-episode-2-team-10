"use client";

import { useLang } from "@/lib/i18nClient";

export interface Improvement {
  title: string;
  why: string;
  action: string;
  example: string;
  quote: string; // exact words from the speech; empty when the model gave none or made one up
}

/** Strengths, then a numbered list of things to improve, most important first. */
export default function ImprovementList({ strengths, improvements }: { strengths: string[]; improvements: Improvement[] }) {
  const { tr } = useLang();
  return (
    <div className="desk-improve">
      {strengths.length > 0 && (
        <>
          <h3>{tr("strengths")}</h3>
          <ul className="desk-strengths">
            {strengths.map((s, i) => (
              <li key={i}>{s}</li>
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
                <strong>{item.title}</strong>
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
    </div>
  );
}
