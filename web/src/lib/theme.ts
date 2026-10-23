"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const KEY = "pitchcoach:theme";
const listeners = new Set<() => void>();

export function readTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.style.colorScheme = theme;
}

export function setTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode: the choice lasts until reload */
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, readTheme, () => "dark");
}

/** Puts the saved theme back on <html> after React hydration. */
export function ThemeSync() {
  const theme = useTheme();
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
  return null;
}
