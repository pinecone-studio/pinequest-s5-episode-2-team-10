"use client";

import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { isProtoModel, parseModelStatuses, type ModelStatus, type ProtoModel } from "@/lib/feedbackModels";
import { t } from "@/lib/i18n";
import { currentLang, langHeaders, useLang } from "@/lib/i18nClient";

const STORAGE_KEY = "pitchcoach:feedback-model";

// The choice lives in memory and is copied to localStorage when storage is allowed.
const listeners = new Set<() => void>();
let current: ProtoModel | null = null;

function snapshot(): ProtoModel {
  if (current) return current;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    current = isProtoModel(saved) && saved !== "rules" ? saved : "ollama";
  } catch {
    current = "ollama"; // storage blocked
  }
  return current;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function choose(next: ProtoModel) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage blocked; the choice lasts until reload */
  }
  listeners.forEach((l) => l());
}

/** The chosen feedback model, remembered in this browser. */
export function useFeedbackModel(): [ProtoModel, (m: ProtoModel) => void] {
  const model = useSyncExternalStore(subscribe, snapshot, () => "ollama" as ProtoModel);
  return [model, choose];
}

export async function fetchModelStatuses(): Promise<ModelStatus[]> {
  const res = await fetch("/api/models", { cache: "no-store", headers: langHeaders() });
  const parsed = parseModelStatuses(await res.json().catch(() => null));
  if (!res.ok || !parsed) throw new Error(t(currentLang(), "modelsLoadFail"));
  return parsed;
}

export default function FeedbackModelSelect({
  value,
  onChange,
}: {
  value: ProtoModel;
  onChange: (m: ProtoModel) => void;
}) {
  const id = useId();
  const { lang, tr } = useLang();
  const [models, setModels] = useState<ModelStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchModelStatuses()
      .then((list) => !cancelled && setModels(list))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [lang]); // reload so the reasons are in the chosen language

  // If the saved choice isn't usable on this machine, fall back to the first one that is.
  useEffect(() => {
    if (!models) return;
    const current = models.find((m) => m.id === value);
    if (current?.available) return;
    const first = models.find((m) => m.available);
    if (first) onChange(first.id);
  }, [models, value, onChange]);

  const selected = models?.find((m) => m.id === value);

  return (
    <div className="desk-model">
      <label htmlFor={id}>{tr("model")}</label>
      <select
        id={id}
        className="desk-field"
        value={value}
        disabled={!models}
        onChange={(e) => isProtoModel(e.target.value) && onChange(e.target.value)}
      >
        {(models ?? [])
          .filter((m) => m.id !== "rules")
          .map((m) => (
          <option key={m.id} value={m.id} disabled={!m.available}>
            {m.name}
            {m.server ? ` · ${tr("backendTag")}` : m.local ? ` · ${tr("thisPc")}` : ` · ${tr("cloud")}`}
            {m.available ? "" : ` (${tr("unavailableTag")})`}
          </option>
        ))}
        {!models && <option value={value}>{tr("loading")}</option>}
      </select>
      {error && <p className="desk-note">{error}</p>}
      {selected && !selected.local && !selected.server && (
        <p className="desk-sub">{tr("cloudNotice")}</p>
      )}
      {models
        ?.filter((m) => !m.available && m.reason)
        .map((m) => (
          <p key={m.id} className="desk-sub">
            {m.name}: {m.reason}
          </p>
        ))}
    </div>
  );
}
