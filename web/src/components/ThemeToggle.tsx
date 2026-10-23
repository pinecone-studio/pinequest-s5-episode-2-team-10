"use client";

import { useLang } from "@/lib/i18nClient";
import { setTheme, useTheme } from "@/lib/theme";

/** Light / dark switch. The choice is kept in this browser. */
export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { tr } = useLang();
  const theme = useTheme();
  return (
    <div className={compact ? "theme-switch is-compact" : "theme-switch"} role="group" aria-label={tr("theme")}>
      <button type="button" aria-pressed={theme === "light"} aria-label={tr("lightMode")} onClick={() => setTheme("light")}>
        <SunIcon />
        {compact ? null : tr("lightMode")}
      </button>
      <button type="button" aria-pressed={theme === "dark"} aria-label={tr("darkMode")} onClick={() => setTheme("dark")}>
        <MoonIcon />
        {compact ? null : tr("darkMode")}
      </button>
    </div>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <circle cx="7" cy="7" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 1.2v1.4M7 11.4v1.4M1.2 7h1.4M11.4 7h1.4M2.8 2.8l1 1M10.2 10.2l1 1M11.2 2.8l-1 1M3.8 10.2l-1 1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M8.2 1.6a4.8 4.8 0 1 0 4.2 7.1A4.2 4.2 0 0 1 8.2 1.6Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
