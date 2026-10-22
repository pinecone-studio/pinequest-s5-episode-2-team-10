import { formatTime } from "@/lib/format";
import { modelName, sendsDataToCloud } from "@/lib/models";
import type { Recommendation, Report, SlideFeedback } from "@/lib/types";

const CATEGORIES = [
  { key: "content", label: "Content", weight: 35 },
  { key: "delivery", label: "Delivery", weight: 30 },
  { key: "slide_alignment", label: "Slide alignment", weight: 25 },
  { key: "timing", label: "Timing", weight: 10 },
] as const;

const CRITERIA: Record<string, string> = {
  problem: "Problem",
  solution: "Solution",
  target_user: "Target user",
  value: "Value and difference",
  logical_order: "Logical order",
  conclusion_cta: "Conclusion and call to action",
};

export default function ReportView({ report }: { report: Report }) {
  const used = CATEGORIES.filter((c) => report[c.key] !== null).length;
  const cloud = sendsDataToCloud(report.backend);
  const { feedback, metrics } = report;

  return (
    <div className="mt-6 space-y-10">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{report.title}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            Feedback by {modelName(report.backend)}
            {cloud && " · data was sent to Anthropic's API"}
          </p>
        </div>
        <div className="text-right">
          <div className="text-5xl font-semibold tabular-nums">{report.overall ?? "–"}</div>
          <div className="text-xs text-zinc-500">
            out of 100{used < 4 && ` · based on ${used} of 4 categories`}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CATEGORIES.map((c) => (
          <div key={c.key} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
            <div className="text-xs text-zinc-500">
              {c.label} · {c.weight}%
            </div>
            <div className="mt-1 text-2xl font-semibold tabular-nums">{report[c.key] ?? "–"}</div>
            {report[c.key] === null && <div className="text-xs text-zinc-400">No data</div>}
          </div>
        ))}
      </div>

      <section>
        <h2 className="mb-2 font-medium">Summary</h2>
        <p className="text-sm leading-relaxed">{feedback.summary}</p>
        {feedback.strengths.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {feedback.strengths.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-emerald-600">+</span>
                {s}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-medium">Top recommendations</h2>
        <ol className="space-y-3">
          {feedback.recommendations.map((r, i) => (
            <RecommendationCard key={i} rec={r} />
          ))}
        </ol>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Delivery</h2>
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <Metric label="Length" value={formatTime(metrics.duration_s)} />
          <Metric label="Pace" value={metrics.wpm} unit="words/min" target="120–150" />
          <Metric label="Fillers" value={metrics.fillers_per_100} unit="per 100 words" target="under 1" />
          <Metric label="Long pauses" value={metrics.long_pauses_per_min} unit="per min" />
          <Metric label="Pitch range" value={metrics.pitch_range_st} unit="semitones" target="6+" />
          <Metric label="Volume drop at end" value={metrics.end_volume_drop_db} unit="dB" />
        </dl>
      </section>

      {feedback.content_scores.length > 0 && (
        <section>
          <h2 className="mb-3 font-medium">Content</h2>
          <div className="space-y-3">
            {feedback.content_scores.map((c) => (
              <div key={c.criterion} className="text-sm">
                <div className="flex justify-between">
                  <span>{CRITERIA[c.criterion] ?? c.criterion}</span>
                  <span className="tabular-nums text-zinc-500">{c.score}</span>
                </div>
                <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <div className="h-full rounded-full bg-zinc-900 dark:bg-zinc-100" style={{ width: `${c.score}%` }} />
                </div>
                {c.recommendation && <p className="mt-1 text-zinc-500">{c.recommendation}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {feedback.slide_feedback.length > 0 && (
        <section>
          <h2 className="font-medium">Slides</h2>
          <p className="mb-3 text-xs text-zinc-500">Estimated from what you said; we don&apos;t know when you changed slides.</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {feedback.slide_feedback.map((s) => (
              <SlideTile key={s.slide} slide={s} />
            ))}
          </div>
          {feedback.number_checks.some((n) => n.inconsistent) && (
            <ul className="mt-4 space-y-1 text-sm">
              {feedback.number_checks
                .filter((n) => n.inconsistent)
                .map((n, i) => (
                  <li key={i} className="text-red-700 dark:text-red-400">
                    Slide {n.slide} says {n.on_slide}, but you said &ldquo;{n.said ?? "nothing"}&rdquo;.
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 font-medium">Transcript</h2>
        <div className="space-y-1.5 text-sm">
          {report.transcript.sentences.map((s, i) => (
            <p key={i} className="flex gap-3">
              <span className="w-10 shrink-0 tabular-nums text-zinc-400">{formatTime(s.start)}</span>
              <span>{s.text}</span>
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

const IMPACT_STYLE = {
  high: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  low: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
};

function RecommendationCard({ rec }: { rec: Recommendation }) {
  return (
    <li className="rounded-lg border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded px-1.5 py-0.5 ${IMPACT_STYLE[rec.impact]}`}>{rec.impact} impact</span>
        <span className="text-zinc-500">{rec.area}</span>
        {rec.start_s != null && <span className="tabular-nums text-zinc-500">at {formatTime(rec.start_s)}</span>}
        {rec.slide != null && <span className="text-zinc-500">slide {rec.slide}</span>}
      </div>
      <p className="font-medium">{rec.problem}</p>
      <p className="mt-1 text-zinc-500">{rec.why}</p>
      <p className="mt-2">{rec.action}</p>
      {rec.example_sentence && (
        <p className="mt-2 border-l-2 border-zinc-300 pl-3 italic text-zinc-600 dark:border-zinc-700 dark:text-zinc-400">
          {rec.example_sentence}
        </p>
      )}
    </li>
  );
}

function Metric({
  label,
  value,
  unit,
  target,
}: {
  label: string;
  value: number | string | null;
  unit?: string;
  target?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <dt className="text-xs text-zinc-500">{label}</dt>
      <dd className="mt-1">
        <span className="text-lg font-semibold tabular-nums">{value ?? "–"}</span>
        {unit && value != null && <span className="ml-1 text-xs text-zinc-500">{unit}</span>}
      </dd>
      {target && <dd className="text-xs text-zinc-400">target {target}</dd>}
    </div>
  );
}

const SLIDE_STYLE: Record<SlideFeedback["status"], string> = {
  covered: "border-emerald-300 dark:border-emerald-800",
  partial: "border-amber-300 dark:border-amber-800",
  missed: "border-red-300 dark:border-red-800",
  image_only: "border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700",
};

function SlideTile({ slide }: { slide: SlideFeedback }) {
  return (
    <div className={`rounded-lg border-2 p-2 text-xs ${SLIDE_STYLE[slide.status]}`}>
      <div className="font-medium">Slide {slide.slide}</div>
      <div className="text-zinc-500">{slide.status === "image_only" ? "image only, not scored" : slide.status}</div>
      {slide.comment && <div className="mt-1">{slide.comment}</div>}
    </div>
  );
}
