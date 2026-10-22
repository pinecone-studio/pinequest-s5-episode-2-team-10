"use client";

import { MODEL_OPTIONS } from "@/lib/models";
import type { FeedbackBackend } from "@/lib/types";

export default function ModelPicker({
  value,
  onChange,
}: {
  value: FeedbackBackend;
  onChange: (v: FeedbackBackend) => void;
}) {
  const selected = MODEL_OPTIONS.find((m) => m.id === value);

  return (
    <div className="space-y-2">
      <div className="grid gap-2">
        {MODEL_OPTIONS.map((m) => (
          <label
            key={m.id}
            className={`flex cursor-pointer items-start justify-between gap-3 rounded-lg border px-3 py-2.5 text-sm ${
              value === m.id
                ? "border-zinc-900 ring-1 ring-zinc-900 dark:border-zinc-100 dark:ring-zinc-100"
                : "border-zinc-300 hover:border-zinc-400 dark:border-zinc-700"
            }`}
          >
            <input
              type="radio"
              name="model"
              value={m.id}
              checked={value === m.id}
              onChange={() => onChange(m.id)}
              className="sr-only"
            />
            <span className="min-w-0">
              <span className="block font-medium">{m.name}</span>
              <span className="block text-zinc-500">{m.detail}</span>
            </span>
            <span
              className={`shrink-0 rounded px-1.5 py-0.5 text-xs ${
                m.runsLocally
                  ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
              }`}
            >
              {m.runsLocally ? "Local · free" : "Cloud API"}
            </span>
          </label>
        ))}
      </div>
      {selected && !selected.runsLocally && (
        <p className="text-xs text-zinc-500">
          Your transcript, metrics and slide text will be sent to Anthropic&apos;s API.
        </p>
      )}
    </div>
  );
}
