"use client";

import { useEffect, useId, useRef, useState } from "react";
import { stopListening } from "@/lib/coachVoice";
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

/** A small "▶ listen" button; while its sound plays it becomes "■ stop". */
export function ListenButton({ label, play }: { label: string; play: () => Promise<void> }) {
  const { tr } = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mine = useRef(false);

  useEffect(
    () => () => {
      if (mine.current) stopListening(); // closing the result stops its sound
    },
    [],
  );

  async function click() {
    if (busy) {
      stopListening();
      return;
    }
    setError(null);
    setBusy(true);
    mine.current = true;
    try {
      await play();
    } catch (err) {
      setError(err instanceof Error ? err.message : tr("ttsFail"));
    } finally {
      mine.current = false;
      setBusy(false);
    }
  }

  return (
    <span className="desk-listen-wrap">
      <button type="button" className="desk-listen" aria-pressed={busy} onClick={click}>
        {busy ? `■ ${tr("stopListening")}` : `▶ ${label}`}
      </button>
      {error && <span className="desk-listen-error">{error}</span>}
    </span>
  );
}

/**
 * Strengths (each with the words that show it), things to improve, and off-topic sentences.
 * An improvement shows its title and what to do; "More info" opens the quote, why and example.
 */
export default function ImprovementList({
  strengths,
  improvements,
  offTopic = [],
  speak,
  hearOwn,
}: {
  strengths: Strength[];
  improvements: Improvement[];
  offTopic?: OffTopic[];
  /** The coach voice reading a sentence; absent while the result is still being written. */
  speak?: (text: string) => Promise<void>;
  /** Plays a quote from the speaker's own recording, or null when its timing isn't known. */
  hearOwn?: (quote: string) => (() => Promise<void>) | null;
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
                {s.quote && hearOwn?.(s.quote) && (
                  <span className="desk-listen-row">
                    <ListenButton label={tr("listenYours")} play={hearOwn(s.quote)!} />
                  </span>
                )}
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
                  {(() => {
                    const own = item.quote && hearOwn ? hearOwn(item.quote) : null;
                    const example = speak && item.example ? item.example : "";
                    if (!own && !example) return null;
                    return (
                      <span className="desk-listen-row">
                        {own && <ListenButton label={tr("listenYours")} play={own} />}
                        {example && <ListenButton label={tr("listenExample")} play={() => speak!(example)} />}
                      </span>
                    );
                  })()}
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
