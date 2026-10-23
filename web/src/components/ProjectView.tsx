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
          <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
        ) : (
          <p className="text-sm text-zinc-500">Loading project…</p>
        )}
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <button onClick={deleteProject} className="text-sm text-zinc-500 underline hover:text-red-600">
          Delete project
        </button>
      </header>

      {error && (
        <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="space-y-6">
          <ProjectDetailsForm key={project.id} project={project} onSaved={setProject} />
          <NewAttempt project={project} onStarted={started} />
        </div>

        <div className="space-y-6">
          <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <h2 className="font-medium">Attempts</h2>
            {project.attempts.length === 0 ? (
              <p className="mt-2 text-sm text-zinc-500">
                No attempts yet. Add a recording and press Analyze; the AI suggestions appear here.
              </p>
            ) : (
              <AttemptList attempts={project.attempts} selected={selected} onSelect={setSelected} />
            )}
          </section>

          {selected && (
            <section>
              <div className="mb-3 flex justify-end">
                <button onClick={() => deleteAttempt(selected)} className="text-xs text-zinc-500 underline hover:text-red-600">
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
        <Link href="/" className="text-sm text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100">
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
              className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                a.id === selected ? "bg-zinc-100 dark:bg-zinc-800" : "hover:bg-zinc-50 dark:hover:bg-zinc-900"
              }`}
            >
              <span className="w-8 shrink-0 text-zinc-500">#{attempts.length - i}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate">{formatDate(a.created_at)}</span>
                <span className="block truncate text-xs text-zinc-500">
                  {a.backend ? modelName(a.backend) : ""}
                  {a.duration_s ? ` · ${formatTime(a.duration_s)}` : ""}
                  {a.slide_count ? ` · ${a.slide_count} slides` : ""}
                  {a.has_script ? " · script" : ""}
                </span>
              </span>
              <span className="shrink-0 text-right">
                {a.status === "processing" ? (
                  <span className="text-xs text-zinc-500">Analyzing…</span>
                ) : a.status === "failed" ? (
                  <span className="text-xs text-red-600">Failed</span>
                ) : (
                  <>
                    <span className="block text-lg font-semibold tabular-nums">{a.overall ?? "–"}</span>
                    {delta !== null && delta !== 0 && (
                      <span className={`block text-xs ${delta > 0 ? "text-emerald-600" : "text-red-600"}`}>
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
