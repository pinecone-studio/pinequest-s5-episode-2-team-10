"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18nClient";
import { clearSession, useAccount } from "@/lib/session";
import LangToggle from "./LangToggle";
import SayloMark from "./SayloMark";
import SidebarPitches from "./SidebarPitches";
import ThemeToggle from "./ThemeToggle";

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
  const openFolder = useSearchParams().get("folder");
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
    if (rect) setPanelBox({ top: rect.bottom + 6, left: rect.left, width: Math.max(rect.width, 220) });
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
          <Link href="/" className="app-brand-link" aria-label={`SAYLO · ${tr("folders")}`}>
            <SayloMark />
            <span className="desk-brand">SAYLO</span>
          </Link>
        </span>
        <ThemeToggle />
      </header>
      {menuOpen && (
        <button type="button" className="app-backdrop" aria-label={tr("close")} onClick={() => setMenuOpen(false)} />
      )}
      <aside id={menuId} className={menuOpen ? "app-side is-open" : "app-side"} inert={narrow && !menuOpen}>
        <div className="app-brand">
          {/* The logo goes to the folder list. */}
          <Link href="/" className="app-brand-link" aria-label={`SAYLO · ${tr("folders")}`} onClick={() => setMenuOpen(false)}>
            <SayloMark />
            <span className="desk-brand">SAYLO</span>
          </Link>
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
          <SidebarPitches home={home} openId={openFolder} onNavigate={() => setMenuOpen(false)} />
        </nav>
      </aside>
      <div className="app-main">
        <div className="app-corner">
          <ThemeToggle />
        </div>
        {children}
      </div>
      {accountOpen && panelBox && (
        <>
          <button type="button" className="account-panel-backdrop" aria-label={tr("close")} onClick={() => setAccountOpen(false)} />
          <div
            className="account-panel"
            role="dialog"
            aria-modal="true"
            aria-label={label || "SAYLO"}
            style={{
              position: "fixed",
              zIndex: 61,
              top: panelBox.top,
              left: panelBox.left,
              width: panelBox.width,
              maxHeight: "calc(100vh - 24px)",
              overflow: "auto",
              boxSizing: "border-box",
              padding: 8,
            }}
          >
            <div className="account-panel-section">
              <p>{tr("currentAccount")}</p>
              <div className="account-panel-user" style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span className="app-avatar" aria-hidden>
                  {(label || email || "?").slice(0, 1).toUpperCase()}
                </span>
                <span className="account-panel-copy" style={{ display: "flex", flexDirection: "column", minWidth: 0, overflow: "hidden" }}>
                  <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label || "SAYLO"}</strong>
                  {email && (
                    <span style={{ display: "block", overflow: "hidden", color: "var(--text-secondary)", fontSize: 12, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {email}
                    </span>
                  )}
                </span>
              </div>
            </div>
            <button
              type="button"
              className="account-panel-logout"
              onClick={logout}
              disabled={busy}
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}
            >
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

