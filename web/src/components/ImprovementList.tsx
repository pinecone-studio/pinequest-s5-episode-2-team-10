"use client";

import { useId, useState } from "react";
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

/**
 * Strengths (each with the words that show it), things to improve, and off-topic sentences.
 * An improvement shows its title and what to do; "More info" opens the quote, why and example.
 */
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
  const id = useId();
  const [open, setOpen] = useState<Set<number>>(new Set());

  function toggle(i: number) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

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
            {improvements.map((item, i) => {
              const more = Boolean(item.quote || item.why || item.example);
              const shown = open.has(i);
              const detailsId = `${id}-more-${i}`;
              return (
                <li key={i}>
                  <strong>
                    {item.title}
                    {item.source === "measured" && <span className="desk-tag">{tr("measuredTag")}</span>}
                  </strong>
                  <span>
                    <em>{tr("improveAction")}:</em> {item.action}
                  </span>
                  {more && shown && (
                    <div id={detailsId} className="desk-improve-more">
                      {item.quote && <q>{item.quote}</q>}
                      {item.why && (
                        <span>
                          <em>{tr("improveWhy")}:</em> {item.why}
                        </span>
                      )}
                      {item.example && (
                        <span>
                          <em>{tr("improveExample")}:</em> «{item.example}»
                        </span>
                      )}
                    </div>
                  )}
                  {more && (
                    <button
                      type="button"
                      className="desk-link desk-improve-toggle"
                      aria-expanded={shown}
                      aria-controls={shown ? detailsId : undefined}
                      onClick={() => toggle(i)}
                    >
                      {shown ? tr("lessInfo") : tr("moreInfo")}
                    </button>
                  )}
                </li>
              );
            })}
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
