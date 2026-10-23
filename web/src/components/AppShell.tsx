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
  const accountMenuId = useId();
  const accountRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
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

  useEffect(() => {
    if (!accountOpen) return;
    function onPointer(event: MouseEvent) {
      if (!accountRef.current?.contains(event.target as Node)) setAccountOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [accountOpen]);

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
          onClick={() => setMenuOpen((open) => !open)}
        >
          <MenuIcon />
          {menuOpen ? tr("close") : tr("menu")}
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
        </div>
        <div className="app-side-top" ref={accountRef}>
          <button
            type="button"
            className="app-account"
            aria-expanded={accountOpen}
            aria-controls={accountMenuId}
            aria-haspopup="menu"
            onClick={() => setAccountOpen((open) => !open)}
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
          {accountOpen && (
            <div id={accountMenuId} className="app-account-menu" role="menu">
              <button type="button" role="menuitem" onClick={logout} disabled={busy}>
                {tr("logOut")}
              </button>
              {process.env.NODE_ENV === "development" && <LangToggle />}
            </div>
          )}
        </div>
        <nav className="app-nav" aria-label="SAYLO">
          <Link href="/" aria-current={home ? "page" : undefined} onClick={() => setMenuOpen(false)}>
            <FolderIcon />
            {tr("folders")}
          </Link>
        </nav>
      </aside>
      <div className="app-main">{children}</div>
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M3 5h12M3 9h12M3 13h12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
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
