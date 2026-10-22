import type { FeedbackBackend } from "./types";

export interface ModelOption {
  id: FeedbackBackend;
  name: string;
  detail: string;
  runsLocally: boolean;
}

// The feedback model is a setting (TDD: "The app's feedback backend is a setting").
// Claude is the default until the fine-tuned model is in Ollama (Mon 26).
export const MODEL_OPTIONS: ModelOption[] = [
  {
    id: "claude",
    name: "Claude",
    detail: "Reads the full analysis JSON. Strongest baseline.",
    runsLocally: false,
  },
  {
    id: "gemma4-ft",
    name: "Gemma 4 E4B (fine-tuned)",
    detail: "Our model, trained on human-corrected pitch feedback.",
    runsLocally: true,
  },
  {
    id: "gemma4-base",
    name: "Gemma 4 E4B (base)",
    detail: "Same prompt, no fine-tuning. For comparison.",
    runsLocally: true,
  },
];

export const DEFAULT_MODEL: FeedbackBackend = "claude";

export function modelName(id: FeedbackBackend): string {
  return MODEL_OPTIONS.find((m) => m.id === id)?.name ?? id;
}
