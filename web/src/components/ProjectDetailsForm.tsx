"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import type { PitchType, Project, ProjectDetails } from "@/lib/types";
import { Card, Field, inputClass } from "./Field";

// Each field saves when you leave it.
export default function ProjectDetailsForm({ project, onSaved }: { project: Project; onSaved: (p: Project) => void }) {
  const [values, setValues] = useState<ProjectDetails>({
    name: project.name,
    goal: project.goal,
    audience: project.audience,
    planned_s: project.planned_s,
    pitch_type: project.pitch_type,
  });
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ProjectDetails>(key: K, value: ProjectDetails[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  async function save(key: keyof ProjectDetails, value = values[key]) {
    if (value === project[key]) return;
    setState("saving");
    setError(null);
    try {
      onSaved(await api.updateProject(project.id, { [key]: value }));
      setState("saved");
    } catch (e) {
      setError(errorMessage(e));
      setState("idle");
    }
  }

  return (
    <Card title="Project details" hint="Used for every new attempt.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Project name" className="sm:col-span-2">
          <input
            className={inputClass}
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            onBlur={() => save("name")}
            placeholder="Hackathon final pitch"
          />
        </Field>
        <Field label="Goal">
          <input
            className={inputClass}
            value={values.goal}
            onChange={(e) => set("goal", e.target.value)}
            onBlur={() => save("goal")}
            placeholder="Win seed funding"
          />
        </Field>
        <Field label="Audience">
          <input
            className={inputClass}
            value={values.audience}
            onChange={(e) => set("audience", e.target.value)}
            onBlur={() => save("audience")}
            placeholder="Judges, investors"
          />
        </Field>
        <Field label="Planned length">
          <select
            className={inputClass}
            value={values.planned_s}
            onChange={(e) => {
              set("planned_s", Number(e.target.value));
              save("planned_s", Number(e.target.value));
            }}
          >
            {[1, 2, 3, 4, 5].map((m) => (
              <option key={m} value={m * 60}>
                {m} min
              </option>
            ))}
          </select>
        </Field>
        <Field label="Pitch type">
          <select
            className={inputClass}
            value={values.pitch_type}
            onChange={(e) => {
              set("pitch_type", e.target.value as PitchType);
              save("pitch_type", e.target.value as PitchType);
            }}
          >
            <option value="startup">Startup pitch</option>
            <option value="academic">Academic talk</option>
          </select>
        </Field>
      </div>
      <p className="mt-2 h-4 text-xs text-zinc-500">
        {error ? <span className="text-red-600">{error}</span> : state === "saving" ? "Saving…" : state === "saved" ? "Saved" : ""}
      </p>
    </Card>
  );
}
