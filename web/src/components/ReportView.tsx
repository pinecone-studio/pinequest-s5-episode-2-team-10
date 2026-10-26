import { formatTime } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import { modelName, sendsDataToCloud } from "@/lib/models";
import type { MainPoints, Recommendation, Report, SlideFeedback } from "@/lib/types";

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
  const { tr } = useLang();
  const used = CATEGORIES.filter((c) => report[c.key] !== null).length;
  const cloud = sendsDataToCloud(report.backend);
  const { feedback, metrics } = report;

  return (
    <div className="mt-4 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="ui-title">{report.title}</h1>
          <p className="ui-muted mt-1">
            Feedback by {modelName(report.backend)}
            {cloud && " · data was sent to Anthropic's API"}
          </p>
        </div>
        <div className="text-right">
          <div className="ui-score">{report.overall ?? "–"}</div>
          <div className="ui-help">
            out of 100{used < 4 && ` · based on ${used} of 4 categories`}
          </div>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {CATEGORIES.map((c) => (
          <div key={c.key} className="ui-card p-3">
            <div className="ui-help">
              {c.label} · {c.weight}%
            </div>
            <div className="ui-score mt-1 text-[18px]">{report[c.key] ?? "–"}</div>
            {report[c.key] === null && <div className="ui-help">No data</div>}
          </div>
        ))}
      </div>

      <section>
        <h2 className="ui-section mb-2">Summary</h2>
        <p className="text-sm leading-relaxed">{feedback.summary}</p>
        {feedback.strengths.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm">
            {feedback.strengths.map((s, i) => (
              <li key={i} className="flex gap-2">
                <span className="ui-ok">+</span>
                {s}
              </li>
            ))}
          </ul>
        )}
      </section>

      {feedback.main_points && feedback.main_points.points.length > 0 && (
        <MainPointsSection data={feedback.main_points} />
      )}

      {!!feedback.practice_tasks?.length && (
        <section>
          <h2 className="ui-section mb-3">{tr("practiceTasks")}</h2>
          <ol className="grid gap-3 sm:grid-cols-2">
            {feedback.practice_tasks.map((task, i) => (
              <li key={`${task.title}-${i}`} className="ui-card p-4">
                <h3 className="text-sm font-semibold">{task.title}</h3>
                <p className="mt-2 text-sm leading-relaxed">{task.instruction}</p>
                <p className="ui-help mt-2">{tr("practiceGoal")}: {task.goal}</p>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section>
        <h2 className="ui-section mb-3">Top recommendations</h2>
        <ol className="space-y-3">
          {feedback.recommendations.map((r, i) => (
            <RecommendationCard key={i} rec={r} />
          ))}
        </ol>
      </section>

      <section>
        <h2 className="ui-section mb-3">Delivery</h2>
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
          <h2 className="ui-section mb-3">Content</h2>
          <div className="space-y-3">
            {feedback.content_scores.map((c) => (
              <div key={c.criterion} className="text-sm">
                <div className="flex justify-between">
                  <span>{CRITERIA[c.criterion] ?? c.criterion}</span>
                  <span className="ui-muted tabular-nums">{c.score}</span>
                </div>
                <div className="ui-meter mt-1">
                  <span style={{ width: `${c.score}%` }} />
                </div>
                {c.recommendation && <p className="ui-muted mt-1">{c.recommendation}</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      {feedback.slide_feedback.length > 0 && (
        <section>
          <h2 className="ui-section">Slides</h2>
          <p className="ui-help mb-3">Estimated from what you said; we don&apos;t know when you changed slides.</p>
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
                  <li key={i} className="ui-bad">
                    Slide {n.slide} says {n.on_slide}, but you said &ldquo;{n.said ?? "nothing"}&rdquo;.
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      <section>
        <h2 className="ui-section mb-3">Transcript</h2>
        <div className="space-y-1.5 text-sm">
          {report.transcript.sentences.map((s, i) => (
            <p key={i} className="flex gap-3">
              <span className="ui-help w-10 shrink-0 tabular-nums">{formatTime(s.start)}</span>
              <span>{s.text}</span>
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

const IMPACT_STYLE = {
  high: "ui-badge is-bad",
  medium: "ui-badge is-warn",
  low: "ui-badge",
};

function RecommendationCard({ rec }: { rec: Recommendation }) {
  return (
    <li className="ui-card text-sm">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className={IMPACT_STYLE[rec.impact]}>{rec.impact} impact</span>
        <span className="ui-help">{rec.area}</span>
        {rec.start_s != null && <span className="ui-help tabular-nums">at {formatTime(rec.start_s)}</span>}
        {rec.slide != null && <span className="ui-help">slide {rec.slide}</span>}
      </div>
      <p className="font-medium">{rec.problem}</p>
      <p className="ui-muted mt-1">{rec.why}</p>
      <p className="mt-2">{rec.action}</p>
      {rec.example_sentence && (
        <p className="ui-quote">
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
    <div className="ui-card p-3">
      <dt className="ui-help">{label}</dt>
      <dd className="mt-1">
        <span className="text-base font-medium tabular-nums">{value ?? "–"}</span>
        {unit && value != null && <span className="ui-help ml-1">{unit}</span>}
      </dd>
      {target && <dd className="ui-help">target {target}</dd>}
    </div>
  );
}

const SLIDE_STYLE: Record<SlideFeedback["status"], string> = {
  covered: "ui-tile is-covered",
  partial: "ui-tile is-partial",
  missed: "ui-tile is-missed",
  image_only: "ui-tile is-image_only",
};

function SlideTile({ slide }: { slide: SlideFeedback }) {
  return (
    <div className={`ui-card p-2 text-xs ${SLIDE_STYLE[slide.status]}`}>
      <div className="font-medium">Slide {slide.slide}</div>
      <div className="ui-help">{slide.status === "image_only" ? "image only, not scored" : slide.status}</div>
      {slide.comment && <div className="mt-1">{slide.comment}</div>}
    </div>
  );
}

const POINT_STATUS = {
  covered: { label: "Covered", className: "ui-badge is-ok" },
  partial: { label: "Partly", className: "ui-badge is-warn" },
  missed: { label: "Missed", className: "ui-badge is-bad" },
} as const;

function MainPointsSection({ data }: { data: MainPoints }) {
  return (
    <section>
      <h2 className="ui-section mb-1">
        Main points{data.coverage !== null && <span className="ui-muted"> · {data.coverage}% covered</span>}
      </h2>
      {data.method === "words" && (
        <p className="ui-help mb-2">Matched by key words without an LLM, so this is a rough estimate.</p>
      )}
      {data.idea_comment && <p className="mb-3 text-sm leading-relaxed">{data.idea_comment}</p>}
      <ul className="space-y-3">
        {data.points.map((p) => {
          const status = POINT_STATUS[p.verified ? p.status : "missed"];
          return (
            <li key={p.point} className="ui-card text-sm">
              <div className="flex items-start justify-between gap-3">
                <span className="font-medium">{p.text}</span>
                <span className={`shrink-0 ${status.className}`}>{status.label}</span>
              </div>
              {p.evidence && <p className="ui-muted mt-1">&ldquo;{p.evidence}&rdquo;</p>}
              {!p.verified && (
                <p className="ui-help mt-1">The model&apos;s quote isn&apos;t in the transcript, so this wasn&apos;t counted.</p>
              )}
              {p.note && <p className="ui-muted mt-1">{p.note}</p>}
            </li>
          );
        })}
      </ul>
      {data.off_topic.length > 0 && (
        <div className="mt-4">
          <h3 className="mb-2 text-sm font-medium">Off topic</h3>
          <ul className="space-y-2 text-sm">
            {data.off_topic.map((o) => (
              <li key={o.sentence_id}>
                {o.start !== null && <span className="ui-help mr-2 tabular-nums">{formatTime(o.start)}</span>}
                &ldquo;{o.text}&rdquo;
                {o.reason && <span className="ui-muted"> · {o.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
