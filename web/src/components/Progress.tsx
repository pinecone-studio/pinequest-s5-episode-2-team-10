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
        <h2 className="ui-section">Analyzing your pitch</h2>
        <p className="ui-muted">
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
                    ? "bg-[#8eae9b] text-[#151617]"
                    : active
                      ? "animate-pulse bg-[#e6e6e6] text-[#151617]"
                      : "border border-[#333436]"
                }`}
              >
                {done ? "✓" : ""}
              </span>
              <span className={done || active ? "" : "ui-help"}>{s.label}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
