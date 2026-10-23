"use client";

import { useEffect, useId } from "react";
import { useLang } from "@/lib/i18nClient";

/** Centered dialog. Rendered outside the sidebar so it does not reflow that column. */
export default function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  /** Wider, and scrolls inside when its content is taller than the screen. */
  wide?: boolean;
}) {
  const { tr } = useLang();
  const titleId = useId();

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="app-modal">
      <button type="button" className="app-modal-backdrop" aria-label={tr("close")} onClick={onClose} />
      <div className={wide ? "app-modal-card app-modal-card-wide" : "app-modal-card"} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="app-modal-bar">
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="app-modal-x"
            aria-label={tr("close")}
            onClick={onClose}
            style={{
              display: "grid",
              width: 32,
              height: 32,
              placeItems: "center",
              border: 0,
              borderRadius: 8,
              background: "transparent",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
          >
            <CloseIcon />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
