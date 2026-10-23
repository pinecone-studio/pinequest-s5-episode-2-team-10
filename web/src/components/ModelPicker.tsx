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
            className={`ui-choice flex cursor-pointer items-start justify-between gap-3 px-3 py-2.5 text-sm ${
              value === m.id ? "is-on" : ""
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
              <span className="ui-help block">{m.detail}</span>
            </span>
            <span className={`ui-badge shrink-0 ${m.runsLocally ? "is-ok" : "is-warn"}`}>
              {m.runsLocally ? "Local · free" : "Cloud API"}
            </span>
          </label>
        ))}
      </div>
      {selected && !selected.runsLocally && (
        <p className="ui-help">
          Your transcript, metrics and slide text will be sent to Anthropic&apos;s API.
        </p>
      )}
    </div>
  );
}
