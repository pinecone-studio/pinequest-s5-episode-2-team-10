"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { errorMessage, formatDate, formatTime } from "@/lib/format";
import { modelName } from "@/lib/models";
import type { Attempt, Project } from "@/lib/types";
import AttemptPanel from "./AttemptPanel";
import NewAttempt from "./NewAttempt";
import ProjectDetailsForm from "./ProjectDetailsForm";

export default function ProjectView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [project, setProject] = useState<Project | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((p: Project) => {
    setProject(p);
    // Keep the selected attempt if it still exists, otherwise show the newest.
    setSelected((cur) => (cur && p.attempts.some((a) => a.id === cur) ? cur : (p.attempts[0]?.id ?? null)));
  }, []);

  const refresh = useCallback(async () => {
    try {
      show(await api.getProject(id));
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, show]);

  useEffect(() => {
    let cancelled = false;
    api.getProject(id).then(
      (p) => !cancelled && show(p),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [id, show]);

  async function deleteProject() {
    if (!project || !confirm(`Delete "${project.name}" and all its attempts? This can't be undone.`)) return;
    try {
      await api.deleteProject(project.id);
      router.push("/");
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function deleteAttempt(attemptId: string) {
    if (!confirm("Delete this attempt and its feedback?")) return;
    try {
      await api.deleteAttempt(attemptId);
      setSelected(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function started(attemptId: string) {
    // Load the project first so the panel knows the new attempt is running.
    await refresh();
    setSelected(attemptId);
  }

  if (!project) {
    return (
      <Shell>
        {error ? (
          <p className="ui-alert">{error}</p>
        ) : (
          <p className="ui-muted">Loading project…</p>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h1 className="ui-title">{project.name}</h1>
        <button onClick={deleteProject} className="ui-link">
          Delete project
        </button>
      </header>

      {error && <p className="ui-alert mb-4">{error}</p>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-6">
          <ProjectDetailsForm key={project.id} project={project} onSaved={setProject} />
          <NewAttempt project={project} onStarted={started} />
        </div>

        <div className="space-y-6">
          <section className="ui-card">
            <h2 className="ui-section">Attempts</h2>
            {project.attempts.length === 0 ? (
              <p className="ui-muted mt-2">
                No attempts yet. Add a recording and press Analyze; the AI suggestions appear here.
              </p>
            ) : (
              <AttemptList attempts={project.attempts} selected={selected} onSelect={setSelected} />
            )}
          </section>

          {selected && (
            <section>
              <div className="mb-3 flex justify-end">
                <button onClick={() => deleteAttempt(selected)} className="ui-link text-[12px]">
                  Delete this attempt
                </button>
              </div>
              <AttemptPanel
                key={selected}
                attemptId={selected}
                running={project.attempts.find((a) => a.id === selected)?.status === "processing"}
                onFinished={refresh}
              />
            </section>
          )}
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-4">
        <Link href="/" className="ui-link">
          ← All projects
        </Link>
      </div>
      {children}
    </div>
  );
}

function AttemptList({
  attempts,
  selected,
  onSelect,
}: {
  attempts: Attempt[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ol className="mt-3 space-y-1.5">
      {attempts.map((a, i) => {
        const older = attempts[i + 1];
        const delta = a.overall != null && older?.overall != null ? a.overall - older.overall : null;
        return (
          <li key={a.id}>
            <button
              onClick={() => onSelect(a.id)}
              className={`ui-row gap-3 ${a.id === selected ? "is-on" : ""}`}
            >
              <span className="ui-help w-8 shrink-0">#{attempts.length - i}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{formatDate(a.created_at)}</span>
                <span className="ui-help block truncate">
                  {a.backend ? modelName(a.backend) : ""}
                  {a.duration_s ? ` · ${formatTime(a.duration_s)}` : ""}
                  {a.slide_count ? ` · ${a.slide_count} slides` : ""}
                  {a.has_script ? " · script" : ""}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {a.status === "processing" ? (
                  <span className="ui-help">Analyzing…</span>
                ) : a.status === "failed" ? (
                  <span className="ui-help ui-bad">Failed</span>
                ) : (
                  <>
                    <span className="block text-sm font-medium tabular-nums">{a.overall ?? "–"}</span>
                    {delta !== null && delta !== 0 && (
                      <span className={`ui-help block ${delta > 0 ? "ui-ok" : "ui-bad"}`}>
                        {delta > 0 ? "+" : ""}
                        {delta}
                      </span>
                    )}
                  </>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
