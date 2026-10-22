"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, USING_MOCK } from "@/lib/api";
import { errorMessage, formatDate } from "@/lib/format";
import type { ProjectSummary } from "@/lib/types";

export default function ProjectsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.listProjects().then(setProjects, (e) => setError(errorMessage(e)));
  }, []);

  async function createProject() {
    setCreating(true);
    setError(null);
    try {
      const p = await api.createProject();
      router.push(`/projects/${p.id}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      // Next keeps this page alive in the background, so reset the button for when the user returns.
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-10">
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">AI Pitch Coach</h1>
          <p className="mt-1 text-sm text-zinc-500">
            One project per pitch. Practice as many times as you like and watch your score improve.
          </p>
        </div>
        <button
          onClick={createProject}
          disabled={creating}
          className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {creating ? "Creating…" : "+ New project"}
        </button>
      </header>

      {USING_MOCK && (
        <p className="mb-6 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
          Demo mode: no backend configured, so projects are saved in this browser and results are sample data. Set
          NEXT_PUBLIC_API_URL to use the FastAPI server.
        </p>
      )}

      {error && (
        <p className="mb-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>
      )}

      {projects === null && !error && <p className="text-sm text-zinc-500">Loading projects…</p>}

      {projects?.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-16 text-center dark:border-zinc-700">
          <p className="font-medium">No projects yet</p>
          <p className="mt-1 text-sm text-zinc-500">
            Create a project for your pitch, add your slides and a recording, and get scored feedback.
          </p>
          <button onClick={createProject} disabled={creating} className="mt-4 text-sm font-medium underline">
            Create your first project
          </button>
        </div>
      )}

      {projects && projects.length > 0 && (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/projects/${p.id}`}
                className="flex h-full flex-col rounded-xl border border-zinc-200 p-4 transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="flex items-center gap-2 font-medium">
                    <FolderIcon />
                    <span className="line-clamp-2">{p.name}</span>
                  </span>
                  <span className="text-2xl font-semibold tabular-nums">{p.latest_overall ?? "–"}</span>
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-4 text-xs text-zinc-500">
                  <span>{p.pitch_type === "academic" ? "Academic talk" : "Startup pitch"}</span>
                  <span>
                    {p.attempt_count} {p.attempt_count === 1 ? "attempt" : "attempts"}
                  </span>
                  <span>Updated {formatDate(p.updated_at)}</span>
                  {p.processing && (
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
                      Analyzing…
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

function FolderIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="shrink-0 text-zinc-400" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}
