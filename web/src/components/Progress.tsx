import type { Stage, StatusResponse } from "@/lib/types";

const STAGES: { id: Stage; label: string }[] = [
  { id: "transcribing", label: "Transcribing speech" },
  { id: "measuring", label: "Measuring pace, pauses and pitch" },
  { id: "slides", label: "Matching speech to slides" },
  { id: "feedback", label: "Writing feedback" },
  { id: "scoring", label: "Computing scores" },
];

export default function Progress({ status }: { status: StatusResponse | null }) {
  const current = status?.stage ? STAGES.findIndex((s) => s.id === status.stage) : -1;
  const queued = status?.queue_position != null && status.queue_position > 0 && !status.stage;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Analyzing your pitch</h2>
        <p className="text-sm text-zinc-500">
          {queued ? `Waiting in line: ${status!.queue_position} ahead of you.` : "This usually takes 20 to 60 seconds."}
        </p>
      </div>
      <ol className="space-y-2">
        {STAGES.map((s, i) => {
          const done = i < current;
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
