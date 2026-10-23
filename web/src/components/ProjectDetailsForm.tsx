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
    idea: project.idea ?? "",
    key_points: project.key_points ?? [],
    planned_s: project.planned_s,
    pitch_type: project.pitch_type,
  });
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ProjectDetails>(key: K, value: ProjectDetails[K]) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  // One main point per line in the text box.
  const [pointsText, setPointsText] = useState((project.key_points ?? []).join("\n"));

  async function save(key: keyof ProjectDetails, value = values[key]) {
    if (JSON.stringify(value) === JSON.stringify(project[key] ?? (key === "key_points" ? [] : ""))) return;
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
        <Field label="Pitch idea" className="sm:col-span-2">
          <input
            className={inputClass}
            value={values.idea}
            maxLength={500}
            onChange={(e) => set("idea", e.target.value)}
            onBlur={() => save("idea")}
            placeholder="A coach that gives students feedback on their pitch in a minute"
          />
        </Field>
        <Field label="Main points (one per line, up to 6)" className="sm:col-span-2">
          <textarea
            className={`${inputClass} h-auto py-2`}
            rows={4}
            value={pointsText}
            onChange={(e) => setPointsText(e.target.value)}
            onBlur={() => {
              const lines = pointsText.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 6);
              setPointsText(lines.join("\n"));
              set("key_points", lines);
              void save("key_points", lines);
            }}
            placeholder={"Students rarely get to practise\nFeedback in under a minute\nWorks in Mongolian"}
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
      <p className="ui-help mt-2 h-4">
        {error ? <span className="ui-bad">{error}</span> : state === "saving" ? "Saving…" : state === "saved" ? <span className="ui-ok">Saved</span> : ""}
      </p>
    </Card>
  );
}
