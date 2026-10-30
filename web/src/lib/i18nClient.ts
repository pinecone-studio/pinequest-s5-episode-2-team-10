"use client";

import { useCallback, useSyncExternalStore } from "react";
import { isLang, LANG_HEADER, t, type Lang, type MessageKey } from "./i18n";

// Browser side: the choice lives in memory and is copied to localStorage when allowed.
const STORAGE_KEY = "pitchcoach:lang";
const listeners = new Set<() => void>();
let current: Lang | null = null;

export function currentLang(): Lang {
  if (current) return current;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    current = isLang(saved) ? saved : "mn";
  } catch {
    current = "mn"; // storage blocked
  }
  return current;
}

export function setLang(next: Lang) {
  current = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage blocked; the choice lasts until reload */
  }
  document.documentElement.lang = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The interface language and a translator bound to it. */
export function useLang(): { lang: Lang; tr: (key: MessageKey, vars?: Record<string, string | number>) => string } {
  const lang = useSyncExternalStore(subscribe, currentLang, () => "mn" as Lang);
  // The same function until the language changes. A new one on every render made hooks that list
  // `tr` as a dependency run again on every render: the admin status page re-fetched in a loop and
  // used up the backend's database connections.
  const tr = useCallback((key: MessageKey, vars?: Record<string, string | number>) => t(lang, key, vars), [lang]);
  return { lang, tr };
}

/** Headers to send with fetches so the API answers in the chosen language. */
export function langHeaders(): Record<string, string> {
  return { [LANG_HEADER]: currentLang() };
}
