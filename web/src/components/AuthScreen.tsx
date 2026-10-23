"use client";

import { useId, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { useLang } from "@/lib/i18nClient";
import { clearSession, saveSession, useAccount } from "@/lib/session";
import LangToggle from "./LangToggle";

type Mode = "login" | "register";

function authMessage(err: unknown, tr: (key: "authEmailTaken" | "authBadLogin" | "authInvalid" | "serverUnreachable" | "authFailed") => string): string {
  const code = err instanceof ApiRequestError ? err.code : err && typeof err === "object" && "code" in err ? String(err.code) : "";
  const status = err instanceof ApiRequestError ? err.status : 0;
  if (code === "email_taken") return tr("authEmailTaken");
  if (code === "invalid_credentials" || status === 401) return tr("authBadLogin");
  if (code === "network" || code === "timeout") return tr("serverUnreachable");
  if (code === "invalid_email" || code === "invalid_request" || status === 422) return tr("authInvalid");
  return tr("authFailed");
}

const UNAVAILABLE = "This sign-in method isn't available yet.";

export default function AuthScreen() {
  const { tr } = useLang();
  const emailId = useId();
  const passwordId = useId();
  const againId = useId();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setNotice(null);
    setAgain("");
  }

  function goBack() {
    if (registering) {
      switchMode("login");
      return;
    }
    if (window.history.length > 1) window.history.back();
  }

  function showUnavailable() {
    setError(null);
    setNotice(UNAVAILABLE);
  }

  async function enterDemo() {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      saveSession(await api.demo());
    } catch (err) {
      setError(authMessage(err, tr));
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (registering && password !== again) {
      setError(tr("authMismatch"));
      return;
    }
    setBusy(true);
    try {
      const session = registering ? await api.register(email, password) : await api.login(email, password);
      saveSession(session);
    } catch (err) {
      setError(authMessage(err, tr));
      setBusy(false);
    }
  }

  return (
    <div className="auth-screen">
      <button type="button" className="auth-back" onClick={goBack}>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
          <path d="M8.5 2.5 4 7l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <div className="auth-frame">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-logo" aria-hidden>
            <WaveMark />
          </div>
          <h1>{registering ? "Create your account" : "Yooo, welcome back!"}</h1>
          <p className="auth-sub">
            {registering ? (
              <>
                Already have an account?{" "}
                <button type="button" onClick={() => switchMode("login")}>
                  Sign in
                </button>
              </>
            ) : (
              <>
                First time here?{" "}
                <button type="button" onClick={() => switchMode("register")}>
                  Sign up for free
                </button>
              </>
            )}
          </p>
          {error && (
            <p className="auth-alert" role="alert">
              {error}
            </p>
          )}
          <div className="auth-fields">
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              autoFocus
              required
              maxLength={254}
              placeholder="Your email"
              aria-label="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <input
              id={passwordId}
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              required
              minLength={8}
              maxLength={128}
              placeholder="Password"
              aria-label="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {registering && (
              <input
                id={againId}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                placeholder="Repeat password"
                aria-label="Repeat password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            )}
          </div>
          <button type="submit" className="auth-primary" disabled={busy}>
            {busy ? "Please wait…" : registering ? "Create account" : "Sign in"}
          </button>
          {!registering && (
            <>
              <button type="button" className="auth-text" onClick={showUnavailable} disabled={busy}>
                Sign in using magic link
              </button>
              <div className="auth-or" role="separator">
                or
              </div>
              <button type="button" className="auth-sso" onClick={showUnavailable} disabled={busy}>
                Single sign-on (SSO)
              </button>
              {notice && (
                <p className="auth-note" role="status">
                  {notice}
                </p>
              )}
              <button type="button" className="auth-demo" onClick={enterDemo} disabled={busy}>
                {tr("signInDemo")}
              </button>
            </>
          )}
          <p className="auth-legal">
            You acknowledge that you read, and agree, to our Terms of Service and our Privacy Policy.
          </p>
        </form>
      </div>
    </div>
  );
}

export function AccountMenu() {
  const { tr } = useLang();
  const account = useAccount();
  const [busy, setBusy] = useState(false);

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
    <div className="desk-account">
      {account?.email && <span className="desk-email">{account.email}</span>}
      <button type="button" className="desk-ghost" onClick={logout} disabled={busy}>
        {tr("logOut")}
      </button>
      {process.env.NODE_ENV === "development" && <LangToggle />}
    </div>
  );
}

function WaveMark() {
  return (
    <svg width="36" height="22" viewBox="0 0 22 14" aria-hidden>
      <path
        d="M1 7h2l2-5 3 10 3-8 2 3h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
