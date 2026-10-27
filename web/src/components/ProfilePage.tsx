"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { ApiRequestError, api } from "@/lib/api";
import { useLang } from "@/lib/i18nClient";
import { updateAccountUsername, useAccount } from "@/lib/session";

function errorCode(error: unknown): string {
  if (error instanceof ApiRequestError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "";
}

export default function ProfilePage() {
  const { tr } = useLang();
  const account = useAccount();
  const [username, setUsername] = useState("");
  const [savedUsername, setSavedUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  const sharedDemo = account?.email.toLowerCase() === "demo@pitchcoach.local";
  const accountId = account?.id;

  useEffect(() => {
    let active = true;
    if (!accountId) return;
    api.me()
      .then((profile) => {
        if (!active) return;
        const name = profile.username ?? "";
        setUsername(name);
        setSavedUsername(profile.username);
        updateAccountUsername(profile.username);
      })
      .catch(() => {
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, reload]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaved(false);
    const cleaned = username.trim().normalize("NFC");
    const length = [...cleaned].length;
    if (length < 1 || length > 40) {
      setError(tr("profileNameInvalid"));
      return;
    }
    setSaving(true);
    try {
      const profile = await api.updateProfile(cleaned);
      const name = profile.username ?? "";
      setUsername(name);
      setSavedUsername(profile.username);
      updateAccountUsername(profile.username);
      setSaved(true);
    } catch (cause) {
      const code = errorCode(cause);
      if (code === "username_taken") {
        setError(tr("profileNameTaken"));
      } else if (code === "shared_account_readonly") {
        setError(tr("profileSharedReadonly"));
      } else if (code === "invalid_username") {
        setError(tr("profileNameInvalid"));
      } else {
        setError(tr("profileSaveFailed"));
      }
    } finally {
      setSaving(false);
    }
  }

  const roleLabel = account?.role === "admin" ? tr("adminPanel") : tr("profileMember");

  return (
    <main className="profile-page">
      <Link href="/" className="profile-back">
        <ChevronLeft />
        {tr("profileBack")}
      </Link>
      <header className="profile-heading">
        <div className="profile-avatar" aria-hidden>
          {(username || account?.email || "?").slice(0, 1).toUpperCase()}
        </div>
        <div>
          <p>{tr("profileEyebrow")}</p>
          <h1>{tr("profileTitle")}</h1>
          <span>{tr("profileDescription")}</span>
        </div>
      </header>

      <section className="profile-card" aria-labelledby="profile-details-title">
        <div className="profile-card-heading">
          <h2 id="profile-details-title">{tr("profileDetails")}</h2>
          <p>{tr("profileDetailsDescription")}</p>
        </div>

        {loading ? (
          <p className="profile-state" role="status">{tr("foldersLoading")}</p>
        ) : loadError ? (
          <div className="profile-state" role="alert">
            <p>{tr("profileLoadFailed")}</p>
            <button
              type="button"
              className="profile-secondary-button"
              onClick={() => {
                setLoadError(false);
                setLoading(true);
                setReload((value) => value + 1);
              }}
            >
              {tr("retry")}
            </button>
          </div>
        ) : (
          <form className="profile-form" onSubmit={save}>
            <label className="profile-field">
              <span>{tr("profileName")}</span>
              <input
                type="text"
                name="username"
                autoComplete="username"
                minLength={1}
                maxLength={40}
                value={username}
                disabled={sharedDemo || saving}
                onChange={(event) => {
                  setUsername(event.target.value);
                  setError("");
                  setSaved(false);
                }}
                aria-describedby="profile-name-hint"
              />
              <small id="profile-name-hint">{tr("profileNameHint")}</small>
            </label>

            <label className="profile-field">
              <span>{tr("profileEmail")}</span>
              <input type="email" value={account?.email ?? ""} readOnly />
            </label>

            <div className="profile-field">
              <span>{tr("profileRole")}</span>
              <div className="profile-readonly-value">{roleLabel}</div>
            </div>

            {sharedDemo && <p className="profile-note">{tr("profileSharedReadonly")}</p>}
            {error && <p className="profile-message is-error" role="alert">{error}</p>}
            {saved && <p className="profile-message is-success" role="status">{tr("profileSaved")}</p>}

            {!sharedDemo && (
              <div className="profile-actions">
                <button
                  type="button"
                  className="profile-secondary-button"
                  onClick={() => {
                    setUsername(savedUsername ?? "");
                    setError("");
                    setSaved(false);
                  }}
                  disabled={saving || username === (savedUsername ?? "")}
                >
                  {tr("profileCancel")}
                </button>
                <button
                  type="submit"
                  className="profile-primary-button"
                  disabled={saving || username.trim() === (savedUsername ?? "")}
                >
                  {saving ? tr("authWorking") : tr("profileSave")}
                </button>
              </div>
            )}
          </form>
        )}
      </section>
    </main>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
