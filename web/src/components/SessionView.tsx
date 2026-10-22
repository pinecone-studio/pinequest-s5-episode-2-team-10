"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import ReportView from "@/components/ReportView";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import type { Report, Stage, StatusResponse } from "@/lib/types";

const POLL_MS = 2000;

const STAGES: { id: Stage; label: string }[] = [
  { id: "transcribing", label: "Transcribing speech" },
  { id: "measuring", label: "Measuring pace, pauses and pitch" },
  { id: "slides", label: "Matching speech to slides" },
  { id: "feedback", label: "Writing feedback" },
  { id: "scoring", label: "Computing scores" },
];

export default function SessionView() {
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      try {
        const s = await api.status(id);
        if (cancelled) return;
        setStatus(s);
        if (s.status === "completed") {
          const r = await api.report(id);
          if (!cancelled) setReport(r);
          return;
        }
        if (s.status === "failed") return;
        timer = window.setTimeout(poll, POLL_MS);
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    }

    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <Link href="/" className="text-sm text-zinc-500 underline hover:text-zinc-900 dark:hover:text-zinc-100">
        ← New session
      </Link>

      {error && (
        <p className="mt-6 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          {error}
        </p>
      )}

      {report ? (
        <ReportView report={report} />
      ) : status?.status === "failed" ? (
        <div className="mt-6 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
          Analysis failed{status.error ? `: ${status.error}` : "."}
        </div>
      ) : (
        !error && <Progress status={status} />
      )}
    </main>
  );
}

function Progress({ status }: { status: StatusResponse | null }) {
  const current = status?.stage ? STAGES.findIndex((s) => s.id === status.stage) : -1;
  const queued = status?.queue_position != null && status.queue_position > 0;

  return (
    <div className="mt-6 space-y-4">
      <h1 className="text-xl font-semibold">Analyzing your pitch</h1>
      <p className="text-sm text-zinc-500">
        {queued
          ? `Waiting in line: ${status!.queue_position} ahead of you.`
          : "This usually takes 20 to 60 seconds."}
      </p>
      <ol className="space-y-2">
        {STAGES.map((s, i) => {
          const done = status?.status === "completed" || i < current;
          const active = i === current;
          return (
            <li key={s.id} className="flex items-center gap-3 text-sm">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  done
                    ? "bg-emerald-600 text-white"
                    : active
                      ? "animate-pulse bg-zinc-900 dark:bg-zinc-100"
                      : "border border-zinc-300 dark:border-zinc-700"
                }`}
              >
                {done ? "✓" : ""}
              </span>
              <span className={done || active ? "" : "text-zinc-400"}>{s.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
