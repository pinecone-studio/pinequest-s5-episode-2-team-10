"use client";

import { useEffect, useState } from "react";
import { api, ApiRequestError, USING_MOCK } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { analysisProjectId } from "@/lib/folderStore";
import { useAccount } from "@/lib/session";
import PracticeGoal from "./PracticeGoal";
import { cellTrend, compareTakes, MAX_TAKES, orderTakes, takeFrom, type Take, type Trend } from "@/lib/takes";

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
    if (!projectId) {
      queueMicrotask(() => finish({ kind: "idle" }));
    } else {
      (async () => {
        try {
          const project = await api.getProject(projectId);
          // Re-analysing a recording adds an attempt, so look at a few more than are shown.
          const done = project.attempts
            .filter((a) => a.status === "completed" && a.has_audio !== false)
            .sort((a, b) => a.created_at.localeCompare(b.created_at))
            .slice(-MAX_TAKES * 2);
          const takes = await Promise.all(done.map(async (a) => takeFrom(a, await api.report(a.id))));
          finish({ kind: "ready", takes: orderTakes(takes) });
        } catch (err) {
          // The project is gone (deleted, or remembered from another database): nothing to show yet.
          finish(err instanceof ApiRequestError && err.status === 404 ? { kind: "idle" } : { kind: "error" });
        }
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [account, folderId, request]);

  const state = result?.value ?? null;
  const takes = state?.kind === "ready" ? state.takes : [];
  const last = takes.at(-1);
  const prev = takes.at(-2);
  const changes = last && prev ? compareTakes(prev, last) : [];

  return (
    <section className="room-card take-history" aria-labelledby={`${folderId}-takes`} aria-busy={loading}>
      <div className="folder-audios-bar">
        <h2 id={`${folderId}-takes`}>{tr("takesTitle")}</h2>
      </div>

      {loading && <p className="take-note">{tr("takesLoading")}</p>}
      {!loading && state?.kind === "error" && <p className="take-note">{tr("takesError")}</p>}
      {!loading && (state?.kind === "idle" || (state?.kind === "ready" && takes.length === 0)) && (
        <p className="take-note">{tr("takesEmpty")}</p>
      )}

      {takes.length > 0 && (
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
      )}

      {takes.length === 1 && <p className="take-note">{tr("takesOne")}</p>}

      {last && prev && (
        <div className="take-since">
          <h3>{tr("takesSince")}</h3>
          {changes.length === 0 ? (
            <p className="take-note">{tr("takesNoChange")}</p>
          ) : (
            <ul>
              {changes.map((c, i) => (
                <li key={i} className={`is-${c.trend}`}>
                  <span className="take-mark" aria-label={tr(TREND_LABEL[c.trend])}>
                    {c.trend === "better" ? "✓" : c.trend === "worse" ? "✗" : "•"}
                  </span>
                  {tr(c.key, c.vars)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {last && <PracticeGoal take={last} />}
    </section>
  );
}
