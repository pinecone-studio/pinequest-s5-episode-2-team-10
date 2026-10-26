"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import { useAccount } from "@/lib/session";
import type { AdminUser, ProjectSummary } from "@/lib/types";
import Modal from "./Modal";

type Change = { role?: "member" | "admin"; is_active?: boolean };
type PendingChange = { user: AdminUser; change: Change; title: string; description: string };
type AdminTab = "overview" | "users" | "pitches";
type PitchFilter = "all" | "processing" | "reviewed" | "new";

const DEMO_EMAIL = "demo@pitchcoach.local";
const DEMO_USERS: AdminUser[] = [
  { id: "demo-admin-preview", email: DEMO_EMAIL, role: "admin", is_active: true, created_at: "2025-01-10T00:00:00Z" },
  { id: "sample-member-01", email: "bat@example.com", role: "member", is_active: true, created_at: "2025-02-14T00:00:00Z" },
  { id: "sample-member-02", email: "saraa@example.com", role: "member", is_active: true, created_at: "2025-03-02T00:00:00Z" },
  { id: "sample-member-03", email: "temuulen@example.com", role: "member", is_active: false, created_at: "2025-03-18T00:00:00Z" },
];

export default function AdminUsersPanel() {
  const { lang, tr } = useLang();
  const router = useRouter();
  const account = useAccount();
  const demoPreview = account?.email === DEMO_EMAIL && account.role !== "admin";
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [lastRefreshAt, setLastRefreshAt] = useState(0);
  const [demoUsers, setDemoUsers] = useState(DEMO_USERS);
  const [query, setQuery] = useState("");
  const [pitchQuery, setPitchQuery] = useState("");
  const [pitchFilter, setPitchFilter] = useState<PitchFilter>("all");
  const [activeTab, setActiveTab] = useState<AdminTab>(demoPreview ? "users" : "overview");
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
      const [nextUsers, nextProjects] = await Promise.all([api.adminUsers(), api.listProjects()]);
      setUsers(nextUsers);
      setProjects(nextProjects);
      setLastRefreshAt(Date.now());
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
    void Promise.all([api.adminUsers(), api.listProjects()]).then(
      ([nextUsers, nextProjects]) => {
        if (current) {
          setUsers(nextUsers);
          setProjects(nextProjects);
          setLastRefreshAt(Date.now());
        }
      },
    ).catch((error: unknown) => {
      if (current) setLoadError(errorMessage(error));
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [account, demoPreview]);

  const displayUsers = demoPreview ? demoUsers : users;
  const isLoading = !demoPreview && loading;
  const visibleUsers = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    if (!term) return displayUsers;
    return displayUsers.filter((user) => `${user.email ?? ""} ${user.id}`.toLocaleLowerCase().includes(term));
  }, [displayUsers, query]);
  const adminOverview = useMemo(() => {
    const weekAgo = lastRefreshAt - 7 * 24 * 60 * 60 * 1000;
    const recentlyUpdated = projects.filter((project) => new Date(project.updated_at).getTime() >= weekAgo).length;
    const members = displayUsers.filter((user) => user.role === "member");
    const activityByUser = new Map<string, { email: string; projects: number; attempts: number }>();
    for (const project of projects) {
      const id = project.owner_id;
      if (!id) continue;
      const owner = displayUsers.find((user) => user.id === id);
      const current = activityByUser.get(id) ?? {
        email: project.owner_email || owner?.email || tr("adminNoEmail"),
        projects: 0,
        attempts: 0,
      };
      current.projects += 1;
      current.attempts += project.attempt_count;
      activityByUser.set(id, current);
    }
    const mostActive = members
      .map((user) => ({
        id: user.id,
        email: user.email || tr("adminNoEmail"),
        projects: activityByUser.get(user.id)?.projects ?? 0,
        attempts: activityByUser.get(user.id)?.attempts ?? 0,
      }))
      .filter((user) => user.projects > 0)
      .sort((a, b) => b.attempts - a.attempts || b.projects - a.projects)
      .slice(0, 5);
    return {
      activeUsers: displayUsers.filter((user) => user.is_active).length,
      memberCount: members.length,
      adminCount: displayUsers.filter((user) => user.role === "admin").length,
      projectCount: projects.length,
      attemptCount: projects.reduce((total, project) => total + project.attempt_count, 0),
      recentlyUpdated,
      mostActive,
      maxAttempts: Math.max(1, ...mostActive.map((user) => user.attempts)),
    };
  }, [displayUsers, lastRefreshAt, projects, tr]);
  const visibleProjects = useMemo(() => {
    const term = pitchQuery.trim().toLocaleLowerCase();
    return [...projects]
      .filter((project) => {
        const statusMatches = pitchFilter === "all"
          || (pitchFilter === "processing" && project.processing)
          || (pitchFilter === "reviewed" && project.latest_overall !== null)
          || (pitchFilter === "new" && project.attempt_count === 0 && !project.processing);
        const searchMatches = !term || `${project.name} ${project.owner_email ?? ""}`.toLocaleLowerCase().includes(term);
        return statusMatches && searchMatches;
      })
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  }, [pitchFilter, pitchQuery, projects]);

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
    if (demoPreview) {
      setDemoUsers((current) => current.map((user) => user.id === pending.user.id ? { ...user, ...pending.change } : user));
      setPending(null);
      setNotice(tr("adminDemoChangeSaved"));
      return;
    }
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

      {demoPreview && <p className="ui-card admin-demo-notice" role="status">{tr("adminDemoNotice")}</p>}

      <nav className="admin-menu" aria-label={tr("adminMenuLabel")}>
        {(["overview", "users", "pitches"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            className={`admin-menu-item ${activeTab === tab ? "is-selected" : ""}`}
            aria-current={activeTab === tab ? "page" : undefined}
            onClick={() => setActiveTab(tab)}
          >
            <span className="admin-menu-icon" aria-hidden="true">{tab === "overview" ? "◫" : tab === "users" ? "◎" : "▤"}</span>
            <span>{tr(tab === "overview" ? "adminMenuOverview" : tab === "users" ? "adminMenuUsers" : "adminMenuPitches")}</span>
            {tab === "users" && <span className="admin-menu-count">{displayUsers.length}</span>}
            {tab === "pitches" && <span className="admin-menu-count">{projects.length}</span>}
          </button>
        ))}
      </nav>

      {loadError && (
        <div className="admin-error" role="alert">
          <span>{loadError}</span>
          <button type="button" className="ui-btn" onClick={() => void loadUsers()}>{tr("retry")}</button>
        </div>
      )}
      {notice && <p className="admin-notice" role="status">{notice}</p>}
      {isLoading && <p className="admin-message" role="status">{tr("loading")}</p>}

      {activeTab === "overview" && !isLoading && !loadError && !demoPreview && (
        <section className="admin-overview" aria-labelledby="admin-overview-heading">
          <div className="admin-overview-heading">
            <div>
              <p className="admin-eyebrow">{tr("adminOverviewEyebrow")}</p>
              <h2 id="admin-overview-heading" className="ui-section">{tr("adminOverviewTitle")}</h2>
            </div>
            <span className="admin-period">{tr("adminOverviewPeriod")}</span>
          </div>
          <div className="admin-stat-grid">
            <article className="ui-card admin-stat-card admin-stat-indigo">
              <span className="admin-stat-icon" aria-hidden="true">◉</span>
              <p>{tr("adminStatActiveUsers")}</p>
              <strong>{adminOverview.activeUsers}<small> / {displayUsers.length}</small></strong>
              <span className="admin-stat-foot">{adminOverview.adminCount} {tr("adminRoleAdmin")} · {adminOverview.memberCount} {tr("adminRoleMember")}</span>
            </article>
            <article className="ui-card admin-stat-card admin-stat-cyan">
              <span className="admin-stat-icon" aria-hidden="true">▱</span>
              <p>{tr("adminStatProjects")}</p>
              <strong>{adminOverview.projectCount}</strong>
              <span className="admin-stat-foot">{adminOverview.recentlyUpdated} {tr("adminStatRecent")}</span>
            </article>
            <article className="ui-card admin-stat-card admin-stat-violet">
              <span className="admin-stat-icon" aria-hidden="true">↗</span>
              <p>{tr("adminStatAttempts")}</p>
              <strong>{adminOverview.attemptCount}</strong>
              <span className="admin-stat-foot">{tr("adminStatAttemptsFoot")}</span>
            </article>
          </div>
          <section className="ui-card admin-activity-card" aria-labelledby="admin-activity-heading">
            <div className="admin-activity-heading">
              <div>
                <h3 id="admin-activity-heading" className="ui-section">{tr("adminActivityTitle")}</h3>
                <p className="ui-help">{tr("adminActivityDescription")}</p>
              </div>
              <span className="admin-activity-count">{adminOverview.mostActive.length} {tr("adminActivityPeople")}</span>
            </div>
            {adminOverview.mostActive.length ? (
              <ol className="admin-activity-list">
                {adminOverview.mostActive.map((user, index) => (
                  <li key={user.id}>
                    <span className={`admin-rank ${index === 0 ? "is-first" : ""}`}>{String(index + 1).padStart(2, "0")}</span>
                    <div className="admin-activity-person">
                      <strong>{user.email}</strong>
                      <span>{tr("adminActivityProjectCount", { count: user.projects })}</span>
                    </div>
                    <div className="admin-activity-meter" aria-label={tr("adminActivityAttemptCount", { count: user.attempts })}>
                      <span style={{ width: `${Math.max(6, (user.attempts / adminOverview.maxAttempts) * 100)}%` }} />
                    </div>
                    <strong className="admin-activity-attempts">{user.attempts}</strong>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="admin-message">{tr("adminActivityEmpty")}</p>
            )}
          </section>
        </section>
      )}

      {activeTab === "users" && !isLoading && !loadError && <section className="ui-card admin-users-card" aria-labelledby="admin-users-heading">
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

        {visibleUsers.length === 0 ? (
          <p className="admin-message">{query ? tr("adminNoMatches") : tr("adminNoUsers")}</p>
        ) : (
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
        )}
      </section>
      }

      {activeTab === "pitches" && !isLoading && !loadError && <section className="ui-card admin-pitches-card" aria-labelledby="admin-pitches-heading">
        <div className="admin-pitches-toolbar">
          <div>
            <p className="admin-eyebrow">{tr("adminPitchEyebrow")}</p>
            <h2 id="admin-pitches-heading" className="ui-section">{tr("adminPitchTitle")}</h2>
            <p className="ui-help">{tr("adminPitchDescription", { count: visibleProjects.length })}</p>
          </div>
          <label className="admin-search">
            <span>{tr("adminPitchSearch")}</span>
            <input value={pitchQuery} onChange={(event) => setPitchQuery(event.target.value)} type="search" />
          </label>
        </div>
        <div className="admin-pitch-filters" role="group" aria-label={tr("adminPitchFilters")}>
          {(["all", "processing", "reviewed", "new"] as const).map((filter) => (
            <button key={filter} type="button" className={`admin-pitch-filter ${pitchFilter === filter ? "is-selected" : ""}`} aria-pressed={pitchFilter === filter} onClick={() => setPitchFilter(filter)}>
              {tr(({ all: "adminPitchFilterAll", processing: "adminPitchFilterProcessing", reviewed: "adminPitchFilterReviewed", new: "adminPitchFilterNew" } as const)[filter])}
              <span>{filter === "all" ? projects.length : filter === "processing" ? projects.filter((project) => project.processing).length : filter === "reviewed" ? projects.filter((project) => project.latest_overall !== null).length : projects.filter((project) => project.attempt_count === 0 && !project.processing).length}</span>
            </button>
          ))}
        </div>
        {visibleProjects.length ? (
          <div className="admin-table-scroll">
            <table className="admin-users-table admin-pitches-table">
              <thead><tr>
                <th scope="col">{tr("adminPitchName")}</th><th scope="col">{tr("adminPitchOwner")}</th><th scope="col">{tr("adminPitchStatus")}</th><th scope="col">{tr("adminPitchAttempts")}</th><th scope="col">{tr("adminPitchScore")}</th><th scope="col">{tr("adminPitchUpdated")}</th><th scope="col">{tr("adminActions")}</th>
              </tr></thead>
              <tbody>{visibleProjects.map((project) => {
                const statusKey = project.processing ? "adminPitchProcessing" : project.attempt_count === 0 ? "adminPitchNewStatus" : project.latest_overall !== null ? "adminPitchReviewed" : "adminPitchAttempted";
                return <tr key={project.id}>
                  <td data-label={tr("adminPitchName")}><strong>{project.name || tr("adminNoEmail")}</strong></td>
                  <td data-label={tr("adminPitchOwner")}>{project.owner_email || tr("adminNoEmail")}</td>
                  <td data-label={tr("adminPitchStatus")}><span className={`admin-badge ${project.processing ? "is-admin" : project.latest_overall !== null ? "is-active" : ""}`}>{tr(statusKey)}</span></td>
                  <td data-label={tr("adminPitchAttempts")}>{project.attempt_count}</td>
                  <td data-label={tr("adminPitchScore")}><span className={`admin-score ${project.latest_overall !== null ? "has-score" : ""}`}>{project.latest_overall ?? "—"}</span></td>
                  <td data-label={tr("adminPitchUpdated")}>{formatCreated(project.updated_at, lang)}</td>
                  <td data-label={tr("adminActions")}><button type="button" className="ui-btn admin-open-pitch" onClick={() => router.push(`/?folder=${encodeURIComponent(project.id)}`)}>{tr("adminPitchOpen")}</button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        ) : (
          <p className="admin-message">{pitchQuery ? tr("adminPitchNoMatches") : tr("adminPitchEmpty")}</p>
        )}
      </section>}

      {pending && (
        <Modal title={pending.title} onClose={() => { if (!saving) setPending(null); }}>
          <form className="admin-confirm-body" onSubmit={(event) => { event.preventDefault(); void applyChange(); }}>
            <p>{pending.description}</p>
            {pending.change.is_active === false && <p className="ui-help">{tr("adminDeactivateNote")}</p>}
            {actionError && <p className="admin-error-text" role="alert">{actionError}</p>}
            <div className="app-modal-actions">
              <button type="button" className="ui-btn" onClick={() => setPending(null)} disabled={saving}>
                {tr("cancel")}
              </button>
              <button type="submit" className="ui-btn-primary" autoFocus disabled={saving}>
                {saving ? tr("loading") : tr("confirm")}
              </button>
            </div>
          </form>
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
