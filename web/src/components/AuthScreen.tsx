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
  const [busy, setBusy] = useState(false);
  const registering = mode === "register";

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setAgain("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
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
    <div className="desk">
      <div className="desk-col">
        <div className="desk-bar">
          <WaveMark />
          <span>Pitch Coach</span>
          {process.env.NODE_ENV === "development" && <LangToggle />}
        </div>
        <div className="desk-title">
          <div>
            <h1>{registering ? tr("signUp") : tr("signIn")}</h1>
            <p className="desk-sub">{tr("authBlurb")}</p>
          </div>
        </div>
        <form className="desk-panel auth-panel" onSubmit={submit}>
          {error && (
            <p className="desk-note" role="alert">
              {error}
            </p>
          )}
          <label htmlFor={emailId}>
            <span>{tr("email")}</span>
            <input
              id={emailId}
              type="email"
              autoComplete="email"
              autoFocus
              required
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label htmlFor={passwordId}>
            <span>{tr("password")}</span>
            <input
              id={passwordId}
              type="password"
              autoComplete={registering ? "new-password" : "current-password"}
              required
              minLength={8}
              maxLength={128}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {registering && (
            <label htmlFor={againId}>
              <span>{tr("passwordAgain")}</span>
              <input
                id={againId}
                type="password"
                autoComplete="new-password"
                required
                minLength={8}
                maxLength={128}
                value={again}
                onChange={(e) => setAgain(e.target.value)}
              />
            </label>
          )}
          <div className="auth-actions">
            <button type="submit" className="desk-primary" disabled={busy}>
              {busy ? tr("authWorking") : registering ? tr("signUp") : tr("signIn")}
            </button>
            <button type="button" className="desk-link" onClick={() => switchMode(registering ? "login" : "register")}>
              {registering ? tr("authHaveAccount") : tr("authNeedAccount")}{" "}
              {registering ? tr("signIn") : tr("signUp")}
            </button>
          </div>
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
    <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden>
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
