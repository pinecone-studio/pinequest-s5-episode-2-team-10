"use client";

import { useSyncExternalStore } from "react";
import { useLang } from "@/lib/i18nClient";

// Hide / show for the pitch page's sections (idea and main points, audio, progress by take).
// Remembered per section in this browser; nothing is stored when storage is blocked.
const KEY = (name: string) => `saylo:hidden:${name}`;
const EVENT = "saylo:section-toggle";
const memory = new Map<string, boolean>(); // used when storage is blocked

function read(name: string): boolean {
  try {
    return localStorage.getItem(KEY(name)) === "1";
  } catch {
    return memory.get(name) ?? false;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** Whether the named section is hidden, and a function that flips it. */
export function useHidden(name: string): [boolean, () => void] {
  const hidden = useSyncExternalStore(subscribe, () => read(name), () => false);
  const toggle = () => {
    memory.set(name, !hidden);
    try {
      if (hidden) localStorage.removeItem(KEY(name));
      else localStorage.setItem(KEY(name), "1");
    } catch {
      /* storage blocked: `memory` keeps it for this page view */
    }
    window.dispatchEvent(new Event(EVENT));
  };
  return [hidden, toggle];
}

/** The Hide / Show button for a section; `controls` is the id of the part it hides. */
export default function SectionToggle({ hidden, onToggle, controls, label }: { hidden: boolean; onToggle: () => void; controls: string; label: string }) {
  const { tr } = useLang();
  return (
    <button
      type="button"
      className="section-toggle"
      aria-expanded={!hidden}
      aria-controls={controls}
      aria-label={`${hidden ? tr("sectionShow") : tr("sectionHide")}: ${label}`}
      onClick={onToggle}
    >
      <span aria-hidden="true">{hidden ? "▸" : "▾"}</span>
      {hidden ? tr("sectionShow") : tr("sectionHide")}
    </button>
  );
}
