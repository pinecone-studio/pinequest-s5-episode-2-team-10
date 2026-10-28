"use client";

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Link from "next/link";
import { ApiRequestError, api } from "@/lib/api";
import type { MessageKey } from "@/lib/i18n";
import { useLang } from "@/lib/i18nClient";
import { updateAccountUsername, useAccount } from "@/lib/session";
import AccountAvatar, { notifyProfileAvatarUpdated } from "./AccountAvatar";

const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

type Errors = { name?: string; password?: string; photo?: string };

function errorCode(error: unknown): string {
  if (error instanceof ApiRequestError) return error.code;
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "";
}

/** A readable message for a failed request: known codes first, then offline, then the fallback. */
function messageFor(error: unknown, known: Record<string, MessageKey>, fallback: MessageKey, tr: (key: MessageKey) => string): string {
  const code = errorCode(error);
  if (known[code]) return tr(known[code]);
  if (code === "shared_account_readonly") return tr("profileSharedReadonly");
  if (code === "network" || code === "timeout") return tr("serverOffline");
  return tr(fallback);
}

/**
 * The signed-in user's profile: photo, username, and password, with one Save for every change.
 * Changes are saved in order (password, username, photo) and stop at the first failure.
 */
export default function ProfilePage() {
  const { tr } = useLang();
  const account = useAccount();
  const accountId = account?.id;
  const sharedDemo = account?.email.toLowerCase() === "demo@pitchcoach.local";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);

  const [username, setUsername] = useState("");
  const [savedUsername, setSavedUsername] = useState<string | null>(null);
  const [hasPassword, setHasPassword] = useState(true);
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");

  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [justSaved, setJustSaved] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    if (!accountId) return;
    api.me()
      .then((profile) => {
        if (!active) return;
        setUsername(profile.username ?? "");
        setSavedUsername(profile.username);
        setHasPassword(profile.has_password !== false);
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

  useEffect(() => () => {
    if (photoPreview) URL.revokeObjectURL(photoPreview);
  }, [photoPreview]);

  const cleanedName = username.trim().normalize("NFC");
  const nameChanged = cleanedName !== (savedUsername ?? "");
  const passwordTouched = !!(current || next || again);
  const dirty = !sharedDemo && (nameChanged || !!photoFile || passwordTouched);
  const locked = sharedDemo || saving || loading || loadError;

  // Leaving with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /** Wraps a setter so typing clears that section's error and the "saved" note. */
  function edit(section: keyof Errors, setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setJustSaved(false);
      setErrors((old) => ({ ...old, [section]: undefined }));
    };
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setJustSaved(false);
    if (file.size > PHOTO_MAX_BYTES) {
      setErrors((old) => ({ ...old, photo: tr("profilePhotoTooLarge") }));
      return;
    }
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setErrors((old) => ({ ...old, photo: tr("profilePhotoInvalid") }));
      return;
    }
    setErrors((old) => ({ ...old, photo: undefined }));
    setPhotoFile(file);
    setPhotoPreview(URL.createObjectURL(file));
  }

  function validate(): Errors {
    const found: Errors = {};
    if (nameChanged) {
      const length = [...cleanedName].length;
      if (length < 1 || length > 40) found.name = tr("profileNameInvalid");
    }
    if (passwordTouched) {
      if (hasPassword && !current) found.password = tr("passwordCurrentMissing");
      else if (next.length < 8 || next.length > 128) found.password = tr("passwordTooShort");
      else if (next !== again) found.password = tr("passwordMismatch");
      else if (hasPassword && next === current) found.password = tr("passwordSame");
    }
    return found;
  }

  function reset() {
    setUsername(savedUsername ?? "");
    setPhotoFile(null);
    setPhotoPreview(null);
    setCurrent("");
    setNext("");
    setAgain("");
    setErrors({});
    setJustSaved(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dirty || saving) return;
    setJustSaved(false);
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    try {
      if (passwordTouched) {
        try {
          await api.changePassword(hasPassword ? current : null, next);
        } catch (cause) {
          setErrors({ password: messageFor(cause, { wrong_password: "passwordWrong", same_password: "passwordSame" }, "passwordFailed", tr) });
          return;
        }
        setHasPassword(true);
        setCurrent("");
        setNext("");
        setAgain("");
      }
      if (nameChanged) {
        try {
          const profile = await api.updateProfile(cleanedName);
          setUsername(profile.username ?? "");
          setSavedUsername(profile.username);
          updateAccountUsername(profile.username);
        } catch (cause) {
          setErrors({ name: messageFor(cause, { username_taken: "profileNameTaken", invalid_username: "profileNameInvalid" }, "profileSaveFailed", tr) });
          return;
        }
      }
      if (photoFile) {
        try {
          await api.uploadProfileAvatar(photoFile);
        } catch (cause) {
          setErrors({ photo: messageFor(cause, { avatar_too_large: "profilePhotoTooLarge", invalid_avatar: "profilePhotoInvalid" }, "profilePhotoFailed", tr) });
          return;
        }
        notifyProfileAvatarUpdated();
        setPhotoFile(null);
        setPhotoPreview(null);
      }
      setJustSaved(true);
    } finally {
      setSaving(false);
    }
  }

  const initial = (username || account?.email || "?").slice(0, 1).toUpperCase();
  const roleLabel = account?.role === "admin" ? tr("adminPanel") : tr("profileMember");
  const status = dirty ? "dirty" : justSaved ? "saved" : "clean";

  return (
    <main className="profile-page">
      <Link href="/" className="profile-back">
        <ChevronLeft />
        {tr("profileBack")}
      </Link>

      <header className="profile-hero">
        <button
          type="button"
          className="profile-avatar-button"
          onClick={() => photoInput.current?.click()}
          disabled={locked}
          aria-label={tr("profilePhotoChange")}
        >
          <AccountAvatar className="profile-avatar" fallback={initial} previewUrl={photoPreview} />
          {!sharedDemo && (
            <span className="profile-avatar-camera" aria-hidden>
              <CameraIcon />
            </span>
          )}
        </button>
        <input
          ref={photoInput}
          className="profile-file-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={choosePhoto}
          tabIndex={-1}
          aria-hidden
        />
        {!sharedDemo && (
          <div className="profile-photo-meta">
            <button type="button" className="profile-photo-link" onClick={() => photoInput.current?.click()} disabled={locked}>
              {tr("profilePhotoChange")}
            </button>
            {errors.photo && (
              <p className="profile-field-error" role="alert">
                {errors.photo}
              </p>
            )}
          </div>
        )}
        <h1>{tr("profileTitle")}</h1>
      </header>

      {loading ? (
        <p className="profile-card profile-state" role="status">
          {tr("foldersLoading")}
        </p>
      ) : loadError ? (
        <div className="profile-card profile-state" role="alert">
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
        <form className="profile-form" onSubmit={save} noValidate>
          <section className="profile-card" aria-labelledby="profile-details-title">
            <div className="profile-card-heading">
              <h2 id="profile-details-title">{tr("profileDetails")}</h2>
            </div>
            <div className="profile-fields">
              <TextField label={tr("profileName")} value={username} onChange={edit("name", setUsername)} disabled={locked} error={errors.name} />
              <TextField label={tr("profileEmail")} value={account?.email ?? ""} readOnly />
              <TextField label={tr("profileRole")} value={roleLabel} readOnly />
            </div>
          </section>

          <section className="profile-card" aria-labelledby="profile-password-title">
            <div className="profile-card-heading">
              <h2 id="profile-password-title">{tr("passwordTitle")}</h2>
            </div>
            <div className="profile-fields">
              {hasPassword && (
                <PasswordField label={tr("passwordCurrent")} autoComplete="current-password" value={current} onChange={edit("password", setCurrent)} disabled={locked} />
              )}
              <PasswordField
                label={tr("passwordNew")}
                autoComplete="new-password"
                value={next}
                onChange={edit("password", setNext)}
                disabled={locked}
                placeholder={tr("passwordHint")}
              />
              <PasswordField label={tr("passwordRepeat")} autoComplete="new-password" value={again} onChange={edit("password", setAgain)} disabled={locked} />
              {errors.password && (
                <p className="profile-field-error" role="alert">
                  {errors.password}
                </p>
              )}
            </div>
          </section>

          {sharedDemo ? (
            <p className="profile-savebar is-readonly">{tr("profileSharedReadonly")}</p>
          ) : (
            <div className="profile-savebar">
              <span className={`profile-savebar-status is-${status}`} aria-live="polite">
                {tr(status === "dirty" ? "profileUnsaved" : status === "saved" ? "profileAllSaved" : "profileUpToDate")}
              </span>
              <div className="profile-savebar-actions">
                <button type="button" className="profile-secondary-button" onClick={reset} disabled={!dirty || saving}>
                  {tr("profileCancel")}
                </button>
                <button type="submit" className="profile-primary-button" disabled={!dirty || saving} aria-busy={saving}>
                  {saving && <span className="profile-spinner" aria-hidden />}
                  {saving ? tr("authWorking") : tr("profileSave")}
                </button>
              </div>
            </div>
          )}
        </form>
      )}
    </main>
  );
}

function TextField({
  label,
  value,
  onChange,
  disabled = false,
  readOnly = false,
  error,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  readOnly?: boolean;
  error?: string;
}) {
  const id = useId();
  return (
    <div className="profile-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        autoComplete={readOnly ? "off" : "username"}
        maxLength={40}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={onChange ? (event) => onChange(event.target.value) : undefined}
      />
      {error && (
        <p className="profile-field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function PasswordField({
  label,
  autoComplete,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  autoComplete: "current-password" | "new-password";
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder?: string;
}) {
  const { tr } = useLang();
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div className="profile-field">
      <label htmlFor={id}>{label}</label>
      <div className="profile-password">
        <input
          id={id}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          maxLength={128}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="profile-password-toggle"
          onClick={() => setVisible((shown) => !shown)}
          aria-label={tr(visible ? "passwordHide" : "passwordShow")}
          aria-pressed={visible}
          disabled={disabled}
        >
          <EyeIcon open={!visible} />
        </button>
      </div>
    </div>
  );
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M1.5 9S4.2 3.8 9 3.8 16.5 9 16.5 9 13.8 14.2 9 14.2 1.5 9 1.5 9Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="9" cy="9" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
      {!open && <path d="M3 15 15 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path d="M2 5.5h2.5L6 3.5h4l1.5 2H14v7.5H2V5.5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx="8" cy="9" r="2.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function ChevronLeft() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
