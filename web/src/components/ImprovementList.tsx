"use client";

// Shapes of the analysis result shown on the pitch page, and the small "listen" button it uses.

import { useEffect, useRef, useState } from "react";
import { stopListening } from "@/lib/coachVoice";
import { useLang } from "@/lib/i18nClient";

export interface Improvement {
  source: "measured" | "model"; // measured: found by code; model: the model's advice
  title: string;
  why: string;
  action: string;
  example: string;
  quote: string; // from the speech; empty when the model gave none or made one up
  category?: string; // e.g. "Слайд": what part of the pitch it is about, already translated
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
export function ListenButton({ label, play, primary = false }: { label: string; play: () => Promise<void>; primary?: boolean }) {
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
      <button type="button" className={primary ? "desk-listen desk-listen-all" : "desk-listen"} aria-pressed={busy} onClick={click}>
        {busy ? `■ ${tr("stopListening")}` : `▶ ${label}`}
      </button>
      {error && <span className="desk-listen-error">{error}</span>}
    </span>
  );
}
