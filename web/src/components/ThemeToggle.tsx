"use client";

import type { MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useLang } from "@/lib/i18nClient";
import { setTheme, useTheme, type Theme } from "@/lib/theme";

/** Switches the theme with a circle that grows out of the toggle, where the browser supports it. */
function switchTheme(next: Theme, event: MouseEvent<HTMLButtonElement>) {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!document.startViewTransition || reduced) {
    setTheme(next);
    return;
  }
  const box = event.currentTarget.getBoundingClientRect();
  const x = box.left + box.width / 2;
  const y = box.top + box.height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const transition = document.startViewTransition(() => flushSync(() => setTheme(next)));
  transition.ready
    .then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 550, easing: "cubic-bezier(0.4, 0, 0.2, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {
      /* transition skipped; the theme is already applied */
    });
}

/** Sun / moon slider for the light and dark theme. The choice is kept in this browser. */
export default function ThemeToggle() {
  const { tr } = useLang();
  const theme = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={dark}
      aria-label={tr("darkMode")}
      title={dark ? tr("darkMode") : tr("lightMode")}
      className={dark ? "theme-switch is-dark" : "theme-switch"}
      onClick={(event) => switchTheme(dark ? "light" : "dark", event)}
    >
      <svg className="theme-switch-scene" viewBox="0 0 56 28" aria-hidden>
        <g className="theme-switch-clouds" fill="#fff">
          <ellipse cx="38" cy="17" rx="6" ry="3.2" />
          <circle cx="36" cy="14.5" r="3" />
          <circle cx="40.5" cy="14" r="3.6" />
          <ellipse cx="47" cy="11" rx="4.5" ry="2.4" opacity="0.85" />
          <circle cx="47.5" cy="9.4" r="2.6" opacity="0.85" />
        </g>
        <g className="theme-switch-stars" fill="#fff">
          <circle cx="10" cy="8" r="0.9" />
          <circle cx="17" cy="16" r="0.7" />
          <circle cx="24" cy="7" r="0.6" />
          <circle cx="8" cy="19" r="0.6" />
          <circle cx="27" cy="19" r="0.9" />
        </g>
      </svg>
      <span className="theme-switch-knob" aria-hidden />
    </button>
  );
}
