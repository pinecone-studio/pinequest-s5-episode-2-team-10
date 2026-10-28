"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useLang } from "@/lib/i18nClient";
import { clearSession, useAccount } from "@/lib/session";
import { BillingBanner, RenewDialog } from "./BillingNotices";
import IntroTour from "./IntroTour";
import LangToggle from "./LangToggle";
import RingBackdrop from "./RingBackdrop";
import SayloMark from "./SayloMark";
import SidebarPitches from "./SidebarPitches";
import AccountAvatar from "./AccountAvatar";
import Modal from "./Modal";

const PANEL_WIDTH = 260;
const INTRO_KEY = "saylo:intro:";
// Accounts that closed the tour this session, for when storage is blocked.
const introClosed = new Set<string>();

function introSeen(accountId: string): boolean {
  if (introClosed.has(accountId)) return true;
  try {
    return localStorage.getItem(INTRO_KEY + accountId) === "1";
  } catch {
    return false;
  }
}

function markIntroSeen(accountId: string) {
  introClosed.add(accountId);
  try {
    localStorage.setItem(INTRO_KEY + accountId, "1");
  } catch {
    /* storage blocked; the tour stays closed until reload */
  }
}

/** Shared signed-in frame: pitches on the left, the account in the top bar, one content area. */
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
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const home = pathname === "/" || pathname === "/figma";
  const openFolder = useSearchParams().get("folder");
  const email = account?.email ?? "";
  const emailLabel = email.includes("@") ? email.slice(0, email.indexOf("@")) : email;
  const label = account?.username || emailLabel;
  const initial = (label || email || "?").slice(0, 1).toUpperCase();
  const isAdmin = account?.role === "admin" || account?.email === "demo@pitchcoach.local";
  // The ring plays behind the pitch list only. The shell stays mounted while signed out, so wait for an account.
  const showScene = account !== null && pathname === "/" && !openFolder;
  // Each account sees the tour once on its first sign-in; the account panel opens it again.
  const [introAsked, setIntroAsked] = useState(false);
  const [introDismissed, setIntroDismissed] = useState<string | null>(null);
  const accountId = account?.id ?? null;
  const showIntro = introAsked || (accountId !== null && introDismissed !== accountId && !introSeen(accountId));

  function closeIntro() {
    if (accountId) markIntroSeen(accountId);
    setIntroDismissed(accountId);
    setIntroAsked(false);
  }

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
    const close = () => setAccountOpen(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [accountOpen]);

  function toggleAccount() {
    if (accountOpen) {
      setAccountOpen(false);
      return;
    }
    const rect = accountBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16);
      setPanelBox({ top: rect.bottom + 8, left: Math.max(8, rect.right - width), width });
    }
    setAccountOpen(true);
  }

  function logout() {
    setAccountOpen(false);
    setLogoutConfirmOpen(true);
  }

  async function confirmLogout() {
    setBusy(true);
    try {
      await api.logout();
    } catch {
      /* the token is already dead; still leave the screen */
    }
    clearSession();
  }

  // Audience present window: slide only, no sidebar or top bar (still inside AuthGate for blobs).
  if (pathname === "/present") return <>{children}</>;

  return (
    <div className={showScene ? "app-shell has-scene" : "app-shell"}>
      {showScene && (
        <>
          <RingBackdrop variant="desk" />
          <div className="landing-grain desk-veil" aria-hidden />
        </>
      )}
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
        </div>
        <nav className="app-nav" aria-label={tr("folders")}>
          <SidebarPitches home={home} openId={openFolder} onNavigate={() => setMenuOpen(false)} />
        </nav>
      </aside>
      <div className="app-main">
        <header className="app-header">
          <button
            type="button"
            className="app-menu"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            aria-label={menuOpen ? tr("close") : tr("menu")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
          <Link href="/" className="app-brand-link app-header-brand" aria-label={`SAYLO · ${tr("folders")}`}>
            <SayloMark />
            <span className="desk-brand">SAYLO</span>
          </Link>
          <div className="app-header-actions">
            {process.env.NODE_ENV === "development" && <LangToggle />}
            <button
              ref={accountBtnRef}
              type="button"
              className="app-account"
              aria-expanded={accountOpen}
              aria-haspopup="dialog"
              aria-label={label || "SAYLO"}
              onClick={toggleAccount}
            >
              <AccountAvatar className="app-avatar" fallback={initial} />
              <span className="app-account-copy">
                <strong>{label || "SAYLO"}</strong>
                {email && <span>{email}</span>}
              </span>
              <ChevronIcon />
            </button>
          </div>
        </header>
        <div className="app-content">
          <BillingBanner />
          {children}
        </div>
      </div>
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
              <Link
                href="/profile"
                className="account-panel-user account-panel-profile"
                aria-label={tr("profile")}
                aria-current={pathname === "/profile" ? "page" : undefined}
                onClick={() => setAccountOpen(false)}
              >
                <AccountAvatar className="app-avatar" fallback={initial} />
                <span className="account-panel-copy">
                  <strong>{label || "SAYLO"}</strong>
                  {email && <span>{email}</span>}
                </span>
                <ChevronRight />
              </Link>
            </div>
            <Link
              href="/billing"
              className="account-panel-link"
              aria-current={pathname === "/billing" ? "page" : undefined}
              onClick={() => setAccountOpen(false)}
            >
              <CardIcon />
              <span>{tr("billing")}</span>
            </Link>
            <button
              type="button"
              className="account-panel-link"
              onClick={() => {
                setAccountOpen(false);
                setIntroAsked(true);
              }}
            >
              <IntroIcon />
              <span>{tr("introOpen")}</span>
            </button>
            {isAdmin && (
              <Link
                href="/admin"
                className="account-panel-link"
                aria-current={pathname === "/admin" ? "page" : undefined}
                onClick={() => setAccountOpen(false)}
              >
                <AdminIcon />
                <span>{tr("adminPanel")}</span>
              </Link>
            )}
            <button type="button" className="account-panel-logout" onClick={logout} disabled={busy}>
              {tr("logOut")}
              <ChevronRight />
            </button>
          </div>
        </>
      )}
      {logoutConfirmOpen && (
        <Modal title={tr("logoutConfirmTitle")} onClose={() => { if (!busy) setLogoutConfirmOpen(false); }}>
          <p className="folder-delete-text">{tr("logoutConfirmDescription")}</p>
          <div className="app-modal-actions folder-delete-actions">
            <button type="button" className="ui-btn" onClick={() => setLogoutConfirmOpen(false)} disabled={busy} autoFocus>
              {tr("cancel")}
            </button>
            <button type="button" className="folder-delete-btn is-confirm" onClick={() => void confirmLogout()} disabled={busy}>
              {busy ? tr("authWorking") : tr("logoutConfirmAction")}
            </button>
          </div>
        </Modal>
      )}
      {showIntro && <IntroTour onClose={closeIntro} />}
      <RenewDialog />
    </div>
  );
}

function CardIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.75" fill="none" stroke="currentColor" strokeWidth="1.35" />
      <path d="M1.75 6.5h12.5M4.5 10h2.5" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
    </svg>
  );
}

function IntroIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2.5 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 0-1.5-1.5h-4v-8ZM13.5 3.5h-4A1.5 1.5 0 0 0 8 5v8a1.5 1.5 0 0 1 1.5-1.5h4v-8Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function AdminIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden>
      <path d="M8.5 1.7 14 3.8v4.1c0 3.5-2.3 5.8-5.5 7.4C5.3 13.7 3 11.4 3 7.9V3.8l5.5-2.1Z" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      <path d="m6.2 8.3 1.5 1.5 3.1-3.2" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" />
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
