"use client";

import { LANGS } from "@/lib/i18n";
import { setLang, useLang } from "@/lib/i18nClient";

const LABELS = { mn: "MN", en: "EN" } as const;

/** Switches the interface between Mongolian and English. Shown only in development. */
export default function LangToggle() {
  const { lang, tr } = useLang();
  return (
    <div className="desk-lang" role="group" aria-label={tr("language")}>
      {LANGS.map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
          {LABELS[l]}
        </button>
      ))}
    </div>
  );
}
