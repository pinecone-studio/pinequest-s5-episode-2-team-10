"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18nClient";
import { clearSession, useAccount } from "@/lib/session";
import LangToggle from "./LangToggle";
import SayloMark from "./SayloMark";

/** Shared signed-in frame: one sidebar, one content area. */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const { tr } = useLang();
  const account = useAccount();
  const pathname = usePathname();
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const accountBtnRef = useRef<HTMLButtonElement>(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [panelBox, setPanelBox] = useState<{ top: number; left: number; width: number } | null>(null);
  const [narrow, setNarrow] = useState(false);
  const [busy, setBusy] = useState(false);
  const home = pathname === "/" || pathname === "/figma";
  const email = account?.email ?? "";
  const label = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const apply = () => setNarrow(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    if (!menuOpen && !accountOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setAccountOpen(false);
      setMenuOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen, accountOpen]);

  function toggleAccount() {
    if (accountOpen) {
      setAccountOpen(false);
      return;
    }
    const rect = accountBtnRef.current?.getBoundingClientRect();
    if (rect) setPanelBox({ top: rect.bottom + 6, left: rect.left, width: rect.width });
    setAccountOpen(true);
  }

  async function logout() {
    setBusy(true);
    try {
      await api.logout();
    } catch {
      /* the token is already dead; still leave the screen */
    }
    clearSession();
  }

  return (
    <div className="app-shell">
      <header className="app-top">
        <button
          type="button"
          className="app-menu"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          aria-label={menuOpen ? tr("close") : undefined}
          onClick={() => setMenuOpen((open) => !open)}
        >
          {menuOpen ? <CloseIcon /> : <MenuIcon />}
          {menuOpen ? null : tr("menu")}
        </button>
        <span className="app-brand">
          <SayloMark />
          <span className="desk-brand">SAYLO</span>
        </span>
      </header>
      {menuOpen && (
        <button type="button" className="app-backdrop" aria-label={tr("close")} onClick={() => setMenuOpen(false)} />
      )}
      <aside id={menuId} className={menuOpen ? "app-side is-open" : "app-side"} inert={narrow && !menuOpen}>
        <div className="app-brand">
          <SayloMark />
          <span className="desk-brand">SAYLO</span>
          {process.env.NODE_ENV === "development" && <LangToggle />}
        </div>
        <div className="app-side-top">
          <button
            ref={accountBtnRef}
            type="button"
            className="app-account"
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            onClick={toggleAccount}
          >
            <span className="app-avatar" aria-hidden>
              {(label || email || "?").slice(0, 1).toUpperCase()}
            </span>
            <span className="app-account-copy">
              <strong>{label || "SAYLO"}</strong>
              {email && <span>{email}</span>}
            </span>
            <ChevronIcon />
          </button>
        </div>
        <nav className="app-nav" aria-label="SAYLO">
          <Link href="/" aria-current={home ? "page" : undefined} onClick={() => setMenuOpen(false)}>
            <FolderIcon />
            {tr("folders")}
          </Link>
        </nav>
      </aside>
      <div className="app-main">{children}</div>
      {accountOpen && panelBox && (
        <>
          <button type="button" className="account-panel-backdrop" aria-label={tr("close")} onClick={() => setAccountOpen(false)} />
          <div
            className="account-panel"
            role="dialog"
            aria-modal="true"
            aria-label={label || "SAYLO"}
            style={{ top: panelBox.top, left: panelBox.left, width: panelBox.width }}
          >
            <div className="account-panel-section">
              <p>{tr("currentAccount")}</p>
              <div className="account-panel-user">
                <span className="app-avatar" aria-hidden>
                  {(label || email || "?").slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{label || "SAYLO"}</strong>
                  {email && <span>{email}</span>}
                </span>
              </div>
            </div>
            <button type="button" className="account-panel-logout" onClick={logout} disabled={busy}>
              {tr("logOut")}
              <ChevronRight />
            </button>
          </div>
        </>
      )}
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

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M3 5h12M3 9h12M3 13h12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronRight() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="M5 3.5 8.5 7 5 10.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M4.5 6.5 8 10l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path
        d="M2.5 5.5h4l1.2-1.5H15.5v9.5h-13V5.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}
