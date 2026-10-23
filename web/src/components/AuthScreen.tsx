"use client";

import { useEffect, useId, useRef, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLang } from "@/lib/i18nClient";
import { clearSession, saveSession, useAccount } from "@/lib/session";
import { googleEnabled, supabase } from "@/lib/supabase";
import LangToggle from "./LangToggle";
import SayloMark from "./SayloMark";
import ThemeToggle from "./ThemeToggle";

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

function googleMessage(err: unknown, tr: (key: "serverUnreachable" | "googleFailed") => string): string {
  const code = err instanceof ApiRequestError ? err.code : err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (code === "network" || code === "timeout" || code === "google_unreachable") return tr("serverUnreachable");
  return tr("googleFailed");
}

const OAUTH_PARAMS = ["code", "error", "error_code", "error_description"];

function clearOAuthParams() {
  const url = new URL(window.location.href);
  if (!OAUTH_PARAMS.some((p) => url.searchParams.has(p))) return;
  OAUTH_PARAMS.forEach((p) => url.searchParams.delete(p));
  window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
}

export default function AuthScreen() {
  const { lang, tr } = useLang();
  const emailId = useId();
  const passwordId = useId();
  const againId = useId();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const exchanging = useRef(false);
  const registering = mode === "register";

  // Back from Google: trade the Supabase session for this app's own token, then drop the Supabase one.
  useEffect(() => {
    const sb = supabase();
    if (!sb) return;
    const { data } = sb.auth.onAuthStateChange((event, session) => {
      if (event === "INITIAL_SESSION" && new URL(window.location.href).searchParams.has("error")) {
        setError(t(lang, "googleFailed"));
        clearOAuthParams();
      }
      if (!session || exchanging.current) return;
      exchanging.current = true;
      // Supabase calls made inside this callback can deadlock, so run after it returns.
      setTimeout(async () => {
        setBusy(true);
        setError(null);
        try {
          saveSession(await api.google(session.access_token));
        } catch (err) {
          setError(googleMessage(err, (key) => t(lang, key)));
          setBusy(false);
        } finally {
          await sb.auth.signOut({ scope: "local" });
          clearOAuthParams();
          exchanging.current = false;
        }
      }, 0);
    });
    return () => data.subscription.unsubscribe();
  }, [lang]);

  async function signInWithGoogle() {
    const sb = supabase();
    setError(null);
    setBusy(true);
    if (!sb || !(await googleEnabled())) {
      setError(tr("googleNotEnabled"));
      setBusy(false);
      return;
    }
    const { error: err } = await sb.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + window.location.pathname },
    });
    if (err) {
      setError(tr("googleFailed"));
      setBusy(false);
    }
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    setAgain("");
  }

  function goBack() {
    if (registering) {
      switchMode("login");
      return;
    }
    if (window.history.length > 1) window.history.back();
  }

  async function enterDemo() {
    setError(null);
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
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <div className="auth-frame">
        <form className="auth-form" onSubmit={submit}>
          <div className="auth-logo" aria-hidden>
            <SayloMark />
          </div>
          <h1>{registering ? "Create your account" : "Yooo, welcome!"}</h1>
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
              <div className="auth-or" role="separator">
                or
              </div>
              <button type="button" className="auth-sso" onClick={signInWithGoogle} disabled={busy}>
                <GoogleMark />
                {tr("signInGoogle")}
              </button>
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

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}
