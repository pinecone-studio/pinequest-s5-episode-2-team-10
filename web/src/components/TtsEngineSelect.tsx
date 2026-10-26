"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { getTtsChoice, isTtsChoice, setTtsChoice, subscribeTts, type TtsChoice, type TtsEngine } from "@/lib/coachVoice";
import type { MessageKey } from "@/lib/i18n";
import { langHeaders, useLang } from "@/lib/i18nClient";

interface EngineStatus {
  id: TtsEngine;
  available: boolean;
  reason: string | null;
}

const NAMES: Record<TtsEngine, MessageKey> = { voice: "ttsVoiceName", azure: "ttsAzureName", elevenlabs: "ttsElevenName" };

/** The chosen coach voice, remembered in this browser. */
export function useTtsChoice(): TtsChoice {
  return useSyncExternalStore(subscribeTts, getTtsChoice, () => "auto" as TtsChoice);
}

/** Picks which voice reads the feedback aloud. Voices this server isn't set up for are disabled. */
export default function TtsEngineSelect() {
  const id = useId();
  const { lang, tr } = useLang();
  const choice = useTtsChoice();
  const [list, setList] = useState<{ engines: EngineStatus[]; defaultEngine: TtsEngine } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/tts", { cache: "no-store", headers: langHeaders() })
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body: { engines: EngineStatus[]; defaultEngine: TtsEngine }) => {
        if (!cancelled && Array.isArray(body?.engines)) setList(body);
      })
      .catch(() => !cancelled && setError(tr("ttsListFail")));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the language changes
  }, [lang]);

  // A saved voice that isn't set up here falls back to the server's default.
  useEffect(() => {
    if (list && choice !== "auto" && !list.engines.find((e) => e.id === choice)?.available) setTtsChoice("auto");
  }, [list, choice]);

  return (
    <span className="desk-tts">
      <label htmlFor={id}>{tr("ttsVoice")}</label>
      <select
        id={id}
        className="desk-field"
        value={choice}
        disabled={!list}
        onChange={(e) => isTtsChoice(e.target.value) && setTtsChoice(e.target.value)}
      >
        <option value="auto">{tr("ttsAuto", { name: list ? tr(NAMES[list.defaultEngine]).split(" · ")[0] : "…" })}</option>
        {(list?.engines ?? []).map((e) => (
          <option key={e.id} value={e.id} disabled={!e.available} title={e.reason ?? undefined}>
            {tr(NAMES[e.id])}
            {e.available ? "" : ` (${tr("ttsNotSetUp")})`}
          </option>
        ))}
      </select>
      {error && <span className="desk-listen-error">{error}</span>}
    </span>
  );
}
