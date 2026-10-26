"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import { useAccount } from "@/lib/session";
import type { AdminUser } from "@/lib/types";
import Modal from "./Modal";

type Change = { role?: "member" | "admin"; is_active?: boolean };
type PendingChange = { user: AdminUser; change: Change; title: string; description: string };

const DEMO_EMAIL = "demo@pitchcoach.local";
const DEMO_USERS: AdminUser[] = [
  { id: "demo-admin-preview", email: DEMO_EMAIL, role: "admin", is_active: true, created_at: "2025-01-10T00:00:00Z" },
  { id: "sample-member-01", email: "bat@example.com", role: "member", is_active: true, created_at: "2025-02-14T00:00:00Z" },
  { id: "sample-member-02", email: "saraa@example.com", role: "member", is_active: true, created_at: "2025-03-02T00:00:00Z" },
  { id: "sample-member-03", email: "temuulen@example.com", role: "member", is_active: false, created_at: "2025-03-18T00:00:00Z" },
];

export default function AdminUsersPanel() {
  const { lang, tr } = useLang();
  const account = useAccount();
  const demoPreview = account?.email === DEMO_EMAIL;
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function loadUsers() {
    if (demoPreview) return;
    setLoading(true);
    setLoadError(null);
    try {
      setUsers(await api.adminUsers());
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (demoPreview) return;
    if (account?.role !== "admin") return;
    let current = true;
    void api.adminUsers().then(
      (result) => {
        if (current) setUsers(result);
      },
      (error: unknown) => {
        if (current) setLoadError(errorMessage(error));
      },
    ).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [account, demoPreview]);

  const displayUsers = demoPreview ? DEMO_USERS : users;
  const visibleUsers = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return displayUsers;
    return displayUsers.filter((user) => `${user.email ?? ""} ${user.id}`.toLocaleLowerCase().includes(term));
  }, [displayUsers, query]);

  function askForChange(user: AdminUser, change: Change) {
    const roleChange = change.role !== undefined;
    setActionError(null);
    setNotice(null);
    setPending({
      user,
      change,
      title: roleChange ? tr("adminRoleConfirmTitle") : tr("adminStatusConfirmTitle"),
      description: roleChange
        ? tr(change.role === "admin" ? "adminPromoteConfirm" : "adminDemoteConfirm", { email: user.email ?? user.id })
        : tr(change.is_active ? "adminActivateConfirm" : "adminDeactivateConfirm", { email: user.email ?? user.id }),
    });
  }

  async function applyChange() {
    if (!pending) return;
    setSaving(true);
    setActionError(null);
    try {
      const updated = await api.updateAdminUser(pending.user.id, pending.change);
      setUsers((current) => current.map((user) => user.id === updated.id ? updated : user));
      setPending(null);
      setNotice(tr("adminSaved"));
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  if (!account || (account.role !== "admin" && !demoPreview)) {
    return (
      <main className="admin-page">
        <header className="admin-page-header">
          <p className="admin-eyebrow">SAYLO</p>
          <h1 className="ui-title">{tr("adminTitle")}</h1>
        </header>
        <section className="ui-card admin-message" role="alert">{tr("adminAccessDenied")}</section>
      </main>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div>
          <p className="admin-eyebrow">SAYLO · {tr("adminPanel")}</p>
          <h1 className="ui-title">{tr("adminTitle")}</h1>
          <p className="ui-muted admin-description">{tr("adminDescription")}</p>
        </div>
        {!demoPreview && (
          <button type="button" className="ui-btn" onClick={() => void loadUsers()} disabled={loading}>
            {loading ? tr("loading") : tr("adminRefresh")}
          </button>
        )}
      </header>

      {demoPreview && <p className="ui-card admin-demo-notice" role="status">{tr("adminDemoReadOnly")}</p>}

      <section className="ui-card admin-users-card" aria-labelledby="admin-users-heading">
        <div className="admin-users-toolbar">
          <div>
            <h2 id="admin-users-heading" className="ui-section">{tr("adminUsers")}</h2>
            <p className="ui-help">{tr("adminUserCount", { count: displayUsers.length })}</p>
          </div>
          <label className="admin-search">
            <span>{tr("adminSearch")}</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} type="search" />
          </label>
        </div>

        {notice && <p className="admin-notice" role="status">{notice}</p>}
        {loadError && (
          <div className="admin-error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="ui-btn" onClick={() => void loadUsers()}>{tr("retry")}</button>
          </div>
        )}
        {loading ? (
          <p className="admin-message" role="status">{tr("loading")}</p>
        ) : !loadError && visibleUsers.length === 0 ? (
          <p className="admin-message">{query ? tr("adminNoMatches") : tr("adminNoUsers")}</p>
        ) : !loadError ? (
          <div className="admin-table-scroll">
            <table className="admin-users-table">
              <thead>
                <tr>
                  <th scope="col">{tr("adminEmail")}</th>
                  <th scope="col">{tr("adminRole")}</th>
                  <th scope="col">{tr("adminStatus")}</th>
                  <th scope="col">{tr("adminCreated")}</th>
                  <th scope="col">{tr("adminActions")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((user) => {
                  const isSelf = user.id === account.id;
                  return (
                    <tr key={user.id}>
                      <td data-label={tr("adminEmail")}>
                        <strong>{user.email ?? tr("adminNoEmail")}</strong>
                        {isSelf && <span className="admin-self-tag">{tr("adminYou")}</span>}
                      </td>
                      <td data-label={tr("adminRole")}>
                        <span className={`admin-badge ${user.role === "admin" ? "is-admin" : ""}`}>
                          {tr(user.role === "admin" ? "adminRoleAdmin" : "adminRoleMember")}
                        </span>
                      </td>
                      <td data-label={tr("adminStatus")}>
                        <span className={`admin-badge ${user.is_active ? "is-active" : "is-inactive"}`}>
                          {tr(user.is_active ? "adminActive" : "adminInactive")}
                        </span>
                      </td>
                      <td data-label={tr("adminCreated")}>{formatCreated(user.created_at, lang)}</td>
                      <td data-label={tr("adminActions")}>
                        {demoPreview ? (
                          <span className="ui-help">{tr("adminDemoSample")}</span>
                        ) : isSelf ? (
                          <span className="ui-help">{tr("adminSelfManaged")}</span>
                        ) : (
                          <div className="admin-actions">
                            <button
                              type="button"
                              className="ui-btn"
                              onClick={() => askForChange(user, { role: user.role === "admin" ? "member" : "admin" })}
                            >
                              {tr(user.role === "admin" ? "adminRemoveRole" : "adminGrantRole")}
                            </button>
                            <button
                              type="button"
                              className={user.is_active ? "ui-btn admin-danger" : "ui-btn"}
                              onClick={() => askForChange(user, { is_active: !user.is_active })}
                            >
                              {tr(user.is_active ? "adminDeactivate" : "adminActivate")}
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {pending && (
        <Modal title={pending.title} onClose={() => { if (!saving) setPending(null); }}>
          <div className="admin-confirm-body">
            <p>{pending.description}</p>
            {pending.change.is_active === false && <p className="ui-help">{tr("adminDeactivateNote")}</p>}
            {actionError && <p className="admin-error-text" role="alert">{actionError}</p>}
            <div className="app-modal-actions">
              <button type="button" className="ui-btn" onClick={() => setPending(null)} disabled={saving}>
                {tr("cancel")}
              </button>
              <button type="button" className="ui-btn-primary" onClick={() => void applyChange()} disabled={saving}>
                {saving ? tr("loading") : tr("confirm")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

function formatCreated(value: string, lang: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat(lang === "mn" ? "mn-MN" : "en", { dateStyle: "medium" }).format(date);
}
