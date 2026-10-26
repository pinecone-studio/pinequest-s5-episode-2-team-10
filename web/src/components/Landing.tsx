"use client";

import dynamic from "next/dynamic";
import { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { MessageKey } from "@/lib/i18n";
import { useLang } from "@/lib/i18nClient";
import SayloMark from "./SayloMark";

const LandingScene = dynamic(() => import("./LandingScene"), { ssr: false, loading: () => null });

type Mode = "login" | "register";

const icon = (path: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {path}
  </svg>
);

const FEATURES: { title: MessageKey; body: MessageKey; icon: ReactNode }[] = [
  { title: "landingF1Title", body: "landingF1Body", icon: icon(<path d="M5 6h14M5 10h14M5 14h9M5 18h6" />) },
  { title: "landingF2Title", body: "landingF2Body", icon: icon(<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2" />) },
  { title: "landingF3Title", body: "landingF3Body", icon: icon(<path d="M3 5h18v12H3zM8 21h8M8 13v-2M12 13V9M16 13v-4" />) },
  { title: "landingF4Title", body: "landingF4Body", icon: icon(<path d="M4 18 10 12l4 4 6-8M15 8h5v5" />) },
];

const STEPS: [MessageKey, MessageKey][] = [
  ["landingStep1Title", "landingStep1Body"],
  ["landingStep2Title", "landingStep2Body"],
  ["landingStep3Title", "landingStep3Body"],
];

const REDUCED = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/** Renders `*word*` in a message as italics. */
function Emphasis({ text }: { text: string }) {
  return (
    <>
      {text.split("*").map((part, i) => (i % 2 ? <em key={i}>{part}</em> : <Fragment key={i}>{part}</Fragment>))}
    </>
  );
}

/** Static stand-in for the 3D ring when motion is reduced or WebGL is missing. */
export function StaticRing() {
  return (
    <div className="landing-fallback" aria-hidden>
      <span className="landing-fallback-ring" />
    </div>
  );
}

/** First screen for signed-out visitors: a ribbed sound ring in 3D behind four short sections. */
export default function Landing({ onStart }: { onStart: (mode: Mode) => void }) {
  const { tr } = useLang();
  const root = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [sceneFailed, setSceneFailed] = useState(false);
  const onSceneFail = useCallback(() => setSceneFailed(true), []);

  useEffect(() => {
    const items = root.current?.querySelectorAll<HTMLElement>(".landing-reveal");
    if (!items?.length) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      },
      { threshold: 0.2 },
    );
    items.forEach((item) => observer.observe(item));
    return () => observer.disconnect();
  }, []);

  return (
    <main className="landing" ref={root}>
      {reduced || sceneFailed ? <StaticRing /> : <LandingScene onFail={onSceneFail} />}
      <div className="landing-grain" aria-hidden />

      <header className="landing-bar">
        <span className="landing-brand">
          <SayloMark />
          <span className="desk-brand">SAYLO</span>
        </span>
        <button type="button" className="landing-link" onClick={() => onStart("login")}>
          {tr("landingSignIn")}
        </button>
      </header>

      <section className="landing-section landing-hero">
        <span className="landing-eyebrow landing-reveal">{tr("landingEyebrow")}</span>
        <h1 className="landing-reveal">
          <Emphasis text={tr("landingTitle")} />
        </h1>
        <p className="landing-reveal">{tr("landingSub")}</p>
        <div className="landing-scroll" aria-hidden>
          <span className="landing-scroll-track" />
          {tr("landingScroll")}
        </div>
      </section>

      <section className="landing-section landing-how">
        <h2 className="landing-reveal">
          <Emphasis text={tr("landingHowTitle")} />
        </h2>
        <ol className="landing-steps">
          {STEPS.map(([title, body], i) => (
            <li key={title} className="landing-step landing-reveal">
              <span className="landing-step-number">{i + 1}</span>
              <h3>{tr(title)}</h3>
              <p>{tr(body)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-section landing-features">
        <h2 className="landing-features-title landing-reveal">
          <Emphasis text={tr("landingFeaturesTitle")} />
        </h2>
        <ul className="landing-cards">
          {FEATURES.map((f) => (
            <li key={f.title} className="landing-card landing-reveal">
              <span className="landing-card-icon">{f.icon}</span>
              <h3>{tr(f.title)}</h3>
              <p>{tr(f.body)}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="landing-section landing-cta">
        <h2 className="landing-reveal">
          <Emphasis text={tr("landingCtaTitle")} />
        </h2>
        <p className="landing-reveal">{tr("landingCtaSub")}</p>
        <div className="landing-actions landing-reveal">
          <button type="button" className="landing-primary" onClick={() => onStart("register")}>
            {tr("landingStart")}
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
              <path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
      </section>

      <footer className="landing-footer">
        <span>{tr("landingFooter")}</span>
        <span>© {new Date().getFullYear()} Saylo</span>
      </footer>
    </main>
  );
}
