"use client";

import { useEffect, useState } from "react";
import { api, ApiRequestError, USING_MOCK } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { analysisProjectId } from "@/lib/folderStore";
import { useAccount } from "@/lib/session";
import PracticeGoal from "./PracticeGoal";
import SectionToggle, { useHidden } from "./SectionToggle";
import { workOn, type Focus } from "@/lib/practiceGoal";
import { cellTrend, compareTakes, loadExampleTakes, MAX_TAKES, orderTakes, takeFrom, type Take, type Trend } from "@/lib/takes";

const DEMO_EMAIL = "demo@pitchcoach.local";

type Metric = "points" | "fillers" | "wpm" | "pauses" | "volume";

const ROWS: { metric: Metric; label: MessageKey; value: (t: Take) => string }[] = [
  { metric: "points", label: "takeRowPoints", value: (t) => (t.total ? `${t.covered}/${t.total}` : "–") },
  { metric: "fillers", label: "takeRowFillers", value: (t) => num(t.fillersPer100, 1) },
  { metric: "wpm", label: "takeRowPace", value: (t) => num(t.wpm, 0) },
  { metric: "pauses", label: "takeRowPauses", value: (t) => num(t.longPausesPerMin, 1) },
  { metric: "volume", label: "takeRowVolume", value: (t) => num(t.endVolumeDropDb, 1) },
];

const num = (n: number | null, digits: number) => (n == null ? "–" : n.toFixed(digits));

const MARK: Record<Trend, string> = { better: "↑", worse: "↓", same: "=", info: "•" };
const TREND_LABEL: Record<Trend, MessageKey> = { better: "takeBetter", worse: "takeWorse", same: "takeSame", info: "takeChanged" };

type Result =
  | { kind: "idle" } // nothing analysed yet for this pitch (or no backend)
  | { kind: "error" }
  | { kind: "ready"; takes: Take[] };

/**
 * The pitch's takes side by side, from its saved analyses, and what changed since the previous
 * take. `version` changes after each new analysis, so the card reloads.
 */
export default function TakeHistory({ folderId, version }: { folderId: string; version: number }) {
  const { tr } = useLang();
  const account = useAccount();
  // Each result remembers the request it answers; until the current one is in, show "loading"
  // (with the previous table, if any, still on screen).
  const request = `${account?.id ?? ""}|${folderId}|${version}`;
  const [result, setResult] = useState<{ request: string; value: Result } | null>(null);
  const loading = result?.request !== request;

  useEffect(() => {
    let cancelled = false;
    const finish = (value: Result) => {
      if (!cancelled) setResult({ request, value });
    };
    const projectId = account && !USING_MOCK ? analysisProjectId(account.id, folderId) : null;
    (async () => {
      // The demo account's demo pitches start with example takes; the visitor's own come after them.
      const examples = account?.email === DEMO_EMAIL ? await loadExampleTakes(folderId) : [];
      const withExamples = (own: Take[]): Result =>
        own.length || examples.length ? { kind: "ready", takes: orderTakes([...examples, ...own]) } : { kind: "idle" };
      if (!projectId) {
        finish(withExamples([]));
        return;
      }
      try {
        const project = await api.getProject(projectId);
        // Re-analysing a recording adds an attempt, so look at a few more than are shown.
        const done = project.attempts
          .filter((a) => a.status === "completed" && a.has_audio !== false)
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(-MAX_TAKES * 2);
        const takes = await Promise.all(done.map(async (a) => takeFrom(a, await api.report(a.id))));
        finish(withExamples(takes));
      } catch (err) {
        // The project is gone (deleted, or remembered from another database): nothing of their own yet.
        finish(err instanceof ApiRequestError && err.status === 404 ? withExamples([]) : { kind: "error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account, folderId, request]);

  const state = result?.value ?? null;
  const takes = state?.kind === "ready" ? state.takes : [];
  const last = takes.at(-1);
  const prev = takes.at(-2);
  const changes = last && prev ? compareTakes(prev, last) : [];

  const [hidden, toggleHidden] = useHidden("pitch-takes");
  const wins = changes.filter((c) => c.trend === "better");
  const slips = changes.filter((c) => c.trend === "worse");
  const notes = changes.filter((c) => c.trend === "info");

  return (
    <section className="room-card take-history" aria-labelledby={`${folderId}-takes`} aria-busy={loading}>
      <div className="section-head">
        <div>
          <h2 id={`${folderId}-takes`}>{tr("takesTitle")}</h2>
          {takes.length > 0 && <p className="desk-sub">{tr("takesCount", { n: takes.length })}</p>}
        </div>
        <SectionToggle hidden={hidden} onToggle={toggleHidden} controls={`${folderId}-takes-body`} label={tr("takesTitle")} />
      </div>

      <div id={`${folderId}-takes-body`} hidden={hidden} className="take-body">
        {loading && takes.length === 0 && <p className="take-note">{tr("takesLoading")}</p>}
        {!loading && state?.kind === "error" && <p className="take-note">{tr("takesError")}</p>}
        {!loading && (state?.kind === "idle" || (state?.kind === "ready" && takes.length === 0)) && (
          <p className="take-note">{tr("takesEmpty")}</p>
        )}

        {/* 1. What to do next: one goal, with a drill. */}
        {last && <PracticeGoal take={last} />}

        {/* 2. What the last take changed. */}
        {last && prev && (
          <div className="take-since">
            <h3>{tr("takesSince")}</h3>
            {changes.length === 0 ? (
              <p className="take-note">{tr("takesNoChange")}</p>
            ) : (
              <div className="take-since-cols">
                {wins.length > 0 && <ChangeList title={tr("takesImproved")} items={wins} />}
                {slips.length > 0 && <ChangeList title={tr("takesSlipped")} items={slips} />}
                {notes.length > 0 && <ChangeList title={tr("takesNoted")} items={notes} />}
              </div>
            )}
          </div>
        )}
        {takes.length === 1 && <p className="take-note">{tr("takesOne")}</p>}

        {/* 3. Each take, newest first, with what to work on in it. */}
        {takes.some((t) => t.example) && <p className="take-note">{tr("takesExampleNote")}</p>}
        {takes.length > 0 && (
          <ol className="take-list" aria-label={tr("takesListLabel")}>
            {[...takes].reverse().map((take, j) => (
              <TakeRow key={take.id} take={take} n={takes.length - j} latest={j === 0} />
            ))}
          </ol>
        )}

        {/* 4. The raw numbers, for anyone who wants them. */}
        {takes.length > 0 && (
          <details className="take-numbers">
            <summary>{tr("takesShowNumbers")}</summary>
            <div className="take-table-wrap">
              <table className="take-table">
                <caption className="sr-only">{tr("takesTitle")}</caption>
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">{tr("takeRowMeasure")}</span>
                    </th>
                    {takes.map((take, i) => (
                      <th key={take.id} scope="col" className={i === takes.length - 1 ? "is-latest" : undefined}>
                        {tr("takeLabel", { n: i + 1 })}
                        <small>{formatDate(take.createdAt)}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {ROWS.map((row) => (
                    <tr key={row.metric}>
                      <th scope="row">{tr(row.label)}</th>
                      {takes.map((take, i) => {
                        const trend = cellTrend(row.metric, takes[i - 1], take);
                        return (
                          <td key={take.id} className={trend ? `is-${trend}` : undefined}>
                            {row.value(take)}
                            {trend && trend !== "same" && (
                              <span className="take-mark" aria-label={tr(TREND_LABEL[trend])}>
                                {" "}
                                {MARK[trend]}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </div>
    </section>
  );
}

function ChangeList({ title, items }: { title: string; items: ReturnType<typeof compareTakes> }) {
  const { tr } = useLang();
  return (
    <div className="take-change-group">
      <h4>{title}</h4>
      <ul>
        {items.map((c, i) => (
          <li key={i} className={`is-${c.trend}`}>
            <span className="take-mark" aria-label={tr(TREND_LABEL[c.trend])}>
              {c.trend === "better" ? "✓" : c.trend === "worse" ? "✗" : "•"}
            </span>
            {tr(c.key, c.vars)}
          </li>
        ))}
      </ul>
    </div>
  );
}

const SHOWN_FOCUS = 3;

/** One take: when, two headline numbers, and what to work on in it. */
function TakeRow({ take, n, latest }: { take: Take; n: number; latest: boolean }) {
  const { tr } = useLang();
  const focus = workOn(take);
  const item = (f: Focus, i: number) => (
    <li key={i} className={`take-focus is-${f.kind}`}>
      <span className="take-focus-dot" aria-hidden="true" />
      <span>
        {tr(f.key, f.vars)}
        {f.hint && <small>{f.hint}</small>}
      </span>
    </li>
  );
  return (
    <li className={`take-row${latest ? " is-latest" : ""}`}>
      <div className="take-row-head">
        <strong>{tr("takeLabel", { n })}</strong>
        {latest && <span className="take-badge">{tr("takeLatest")}</span>}
        {take.example && <span className="take-badge is-example">{tr("takeExample")}</span>}
        <span className="take-row-date">{formatDate(take.createdAt)}</span>
        <span className="take-row-stats">
          {take.total > 0 && <span>{tr("takeChipPoints", { covered: take.covered, total: take.total })}</span>}
          {take.fillersPer100 != null && <span>{tr("takeChipFillers", { per100: take.fillersPer100.toFixed(1) })}</span>}
        </span>
      </div>
      {focus.length === 0 ? (
        <p className="take-row-good">✓ {tr("takeAllGood")}</p>
      ) : (
        <div className="take-row-work">
          <span className="take-row-label">{tr("takeWorkOn")}</span>
          <ul>{focus.slice(0, SHOWN_FOCUS).map(item)}</ul>
          {focus.length > SHOWN_FOCUS && (
            <details className="take-more">
              <summary>{tr("takeMore", { n: focus.length - SHOWN_FOCUS })}</summary>
              <ul>{focus.slice(SHOWN_FOCUS).map((f, i) => item(f, i + SHOWN_FOCUS))}</ul>
            </details>
          )}
        </div>
      )}
    </li>
  );
}
