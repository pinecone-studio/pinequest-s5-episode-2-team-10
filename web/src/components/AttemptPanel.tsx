"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import type { Report, StatusResponse } from "@/lib/types";
import Progress from "./Progress";
import ReportView from "./ReportView";
import Uploads from "./Uploads";

const POLL_MS = 2000;

// Shows one attempt: progress while it runs, then the AI suggestions and the uploads.
export default function AttemptPanel({
  attemptId,
  running,
  onFinished,
}: {
  attemptId: string;
  running: boolean; // what the project page currently believes
  onFinished: () => void;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    // Refresh the project when this attempt ends, including when it ended before the first poll.
    let wasRunning = running;

    async function poll() {
      try {
        const s = await api.status(attemptId);
        if (cancelled) return;
        setStatus(s);
        if (s.status === "processing") {
          wasRunning = true;
          timer = window.setTimeout(poll, POLL_MS);
          return;
        }
        if (s.status === "completed") {
          const r = await api.report(attemptId);
          if (!cancelled) setReport(r);
        }
        if (wasRunning) onFinished();
      } catch (e) {
        if (!cancelled) setError(errorMessage(e));
      }
    }

    poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // Only restart polling for a different attempt, not when the callback or flag changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attemptId]);

  if (error) {
    return <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>;
  }
  if (report) {
    return (
      <div className="space-y-6">
        {report.notes.length > 0 && (
          <ul className="space-y-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-300">
            {report.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        )}
        <ReportView report={report} />
        <Uploads report={report} />
      </div>
    );
  }
  if (status?.status === "failed") {
    return (
      <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
        Analysis failed{status.error ? `: ${status.error}` : "."}
      </p>
    );
  }
  return <Progress status={status} />;
}
