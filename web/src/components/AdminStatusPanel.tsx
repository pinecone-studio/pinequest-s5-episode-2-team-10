"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { isLocalHost } from "@/lib/build";
import { errorMessage, formatDate } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { routeHeaders } from "@/lib/routeAccess";
import type { AdminStatus, DeployedStatus } from "@/lib/types";

const REFRESH_MS = 30_000;

// Green: working. Yellow: up but not working correctly (or can't be checked). Red: down.
// Grey only until the first check answers.
type Health = "ok" | "warn" | "down" | "checking";

interface Part {
  key: string;
  icon: string;
  name: MessageKey;
  health: Health;
  lines: string[]; // details, one per line
  error?: string; // what's wrong, shown in the card's colour
}

type View = "this" | "deployed";

/** The web server's own link to the voice server (GET /api/transcribe), used for live transcription. */
interface WebVoice {
  ok: boolean;
  device?: string;
  modelLoaded?: boolean;
  busy?: boolean;
  error?: string;
}

const HEALTH_LABEL: Record<Health, MessageKey> = { ok: "statusOk", warn: "statusWarn", down: "statusDown", checking: "statusChecking" };

async function webVoice(): Promise<WebVoice | null> {
  try {
    const res = await fetch("/api/transcribe", { headers: routeHeaders(), cache: "no-store" });
    return (await res.json()) as WebVoice;
  } catch {
    return null;
  }
}

const lines = (...parts: (string | false | null | undefined)[]) => parts.filter((p): p is string => Boolean(p));

function PartCard({ part }: { part: Part }) {
  const { tr } = useLang();
  return (
    <article className={`ui-card admin-stat-card admin-service is-${part.health}`}>
      <div className="admin-service-head">
        <span className="admin-stat-icon" aria-hidden="true">{part.icon}</span>
        <span className="admin-status-light" role="img" aria-label={tr(HEALTH_LABEL[part.health])} />
      </div>
      <strong>{tr(part.name)}</strong>
      {part.error && <span className="admin-service-error">{part.error}</span>}
      {part.lines.map((line, i) => (
        <span key={i} className="admin-stat-foot">{line}</span>
      ))}
    </article>
  );
}

function Summary({ parts, checkedAt, note }: { parts: Part[]; checkedAt: string | null; note?: string }) {
  const { tr } = useLang();
  const down = parts.filter((p) => p.health === "down").length;
  const warn = parts.filter((p) => p.health === "warn").length;
  const overall: Health = !checkedAt ? "checking" : down ? "down" : warn ? "warn" : "ok";
  return (
    <div className={`ui-card admin-status-summary is-${overall}`} role="status">
      <span className="admin-status-light" aria-hidden="true" />
      <div>
        <strong>
          {!checkedAt ? tr("statusChecking") : down ? tr("statusSomeDown", { n: down }) : warn ? tr("statusSomeWarn", { n: warn }) : tr("statusAllOk")}
        </strong>
        <span>{checkedAt ? `${tr("statusCheckedAt", { time: formatDate(checkedAt) })} · ${tr("statusAutoRefresh")}` : note}</span>
      </div>
    </div>
  );
}

/** Admin "Status" tab: is every part the app needs up and working, here and on the deployed site. */
export default function AdminStatusPanel() {
  const { lang, tr } = useLang();
  // Read after mount, so server and browser render the same. `host` has the port (shown); `hostname` doesn't (checked).
  const [page, setPage] = useState<{ host: string; hostname: string } | null>(null);
  const host = page?.host ?? null;
  const [view, setView] = useState<View>("this");

  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [voice, setVoice] = useState<WebVoice | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [gemmaTest, setGemmaTest] = useState<AdminStatus["gemma_test"]>(null);

  const [deployed, setDeployed] = useState<DeployedStatus | null>(null);
  const [deployedError, setDeployedError] = useState<string | null>(null);
  const [deployedAt, setDeployedAt] = useState<string | null>(null);

  const local = page != null && isLocalHost(page.hostname);

  const load = useCallback(async (testGemma = false) => {
    if (testGemma) setTesting(true);
    else setChecking(true);
    const [backend, web] = await Promise.all([
      api.adminStatus(testGemma).then(
        (s) => ({ ok: true as const, s }),
        (err: unknown) => ({ ok: false as const, message: errorMessage(err) }),
      ),
      webVoice(),
    ]);
    if (backend.ok) {
      setStatus(backend.s);
      setBackendError(null);
      if (testGemma) setGemmaTest(backend.s.gemma_test);
    } else {
      setStatus(null);
      setBackendError(backend.message);
    }
    setVoice(web);
    setCheckedAt(new Date().toISOString());
    setChecking(false);
    setTesting(false);
  }, []);

  const loadDeployed = useCallback(async () => {
    setChecking(true);
    try {
      setDeployed(await api.adminStatusDeployed(lang));
      setDeployedError(null);
    } catch (err) {
      setDeployed(null);
      setDeployedError(errorMessage(err));
    }
    setDeployedAt(new Date().toISOString());
    setChecking(false);
  }, [lang]);

  useEffect(() => {
    const first = window.setTimeout(() => setPage({ host: window.location.host, hostname: window.location.hostname }), 0);
    return () => window.clearTimeout(first);
  }, []);

  useEffect(() => {
    const run = view === "this" ? () => void load() : () => void loadDeployed();
    const first = window.setTimeout(run, 0);
    const timer = window.setInterval(run, REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [view, load, loadDeployed]);

  const ms = (n: number) => tr("statusMs", { ms: n });
  const where = (w: "local" | "remote") => tr(w === "local" ? "statusLocal" : "statusRemote");

  // ---- This site: the backend the page uses, and this web server ----------------------------------
  const thisParts: Part[] = [{ key: "web", icon: "◫", name: "statusWeb", health: "ok", lines: [host ?? ""] }];
  if (!checkedAt) {
    thisParts.push({ key: "web-voice", icon: "⇄", name: "statusWebVoice", health: "checking", lines: [] });
  } else if (!voice || !voice.ok) {
    thisParts.push({ key: "web-voice", icon: "⇄", name: "statusWebVoice", health: "down", lines: [], error: voice?.error ?? tr("statusUnreachable") });
  } else {
    thisParts.push({
      key: "web-voice",
      icon: "⇄",
      name: "statusWebVoice",
      health: voice.modelLoaded ? "ok" : "warn",
      lines: lines(voice.device, voice.busy && tr("statusBusy")),
      error: voice.modelLoaded ? undefined : tr("statusModelNotLoaded"),
    });
  }
  if (!status) {
    const pending: Health = checkedAt ? "warn" : "checking";
    const cantCheck = checkedAt ? tr("statusNeedsBackend") : undefined;
    thisParts.push(
      { key: "backend", icon: "◎", name: "statusBackend", health: checkedAt ? "down" : "checking", lines: [], error: backendError ?? undefined },
      { key: "database", icon: "▤", name: "statusDatabase", health: pending, lines: [], error: cantCheck },
      { key: "voice", icon: "◉", name: "statusVoice", health: pending, lines: [], error: cantCheck },
      { key: "gemma", icon: "✦", name: "statusGemma", health: pending, lines: [], error: cantCheck },
    );
  } else {
    const { backend, database, voice: v, ollama: o } = status;
    const partOnCpu = o.gpu_share != null && o.gpu_share < 1;
    thisParts.push(
      {
        key: "backend",
        icon: "◎",
        name: "statusBackend",
        health: "ok",
        lines: [backend.analysing ? tr("statusAnalysing") : tr("statusIdle"), tr("statusQueue", { n: backend.queue_length })],
      },
      { key: "database", icon: "▤", name: "statusDatabase", health: database.ok ? "ok" : "down", lines: database.ok ? [ms(database.ms)] : [], error: database.error },
      {
        key: "voice",
        icon: "◉",
        name: "statusVoice",
        // Down only matters when the analysis uses it; otherwise it's a warning.
        health: !v.ok ? (v.used ? "down" : "warn") : !v.cuda ? "warn" : "ok",
        lines: lines(v.ok && v.device, v.ok && v.busy && tr("statusBusy"), `${where(v.where)} · ${ms(v.ms)}`, !v.used && tr("statusVoiceUnused")),
        error: !v.ok ? v.error : !v.cuda ? tr("statusCpu") : undefined,
      },
      {
        key: "gemma",
        icon: "✦",
        name: "statusGemma",
        health: !o.ok ? "down" : partOnCpu ? "warn" : "ok",
        lines: lines(
          o.ok && o.model,
          o.ok && (o.loaded ? tr("statusModelLoaded") : tr("statusModelNotLoadedGemma")),
          `${where(o.where)} · ${ms(o.ms)}`,
        ),
        error: !o.ok ? o.error : partOnCpu ? tr("statusGpuShare", { pct: Math.round((o.gpu_share ?? 0) * 100) }) : undefined,
      },
    );
  }

  // ---- The deployed site, checked by the backend this page uses ---------------------------------
  // Its Gemma as its backend reports it (in its public /health).
  const deployedGemma = (b: DeployedStatus["backend"]): Part => {
    const base = { key: "d-gemma", icon: "✦", name: "statusDeployedGemma" as MessageKey };
    if (!b.ok) return { ...base, health: "warn", lines: [], error: tr("statusNeedsDeployedBackend") };
    const g = b.gemma;
    if (!g) return { ...base, health: "warn", lines: [], error: tr("statusGemmaNotReported") };
    const partOnCpu = g.gpu_share != null && g.gpu_share < 1;
    return {
      ...base,
      health: !g.ok ? "down" : partOnCpu ? "warn" : "ok",
      lines: lines(g.model, g.ok && (g.loaded ? tr("statusModelLoaded") : tr("statusModelNotLoadedGemma"))),
      error: !g.ok ? g.error : partOnCpu ? tr("statusGpuShare", { pct: Math.round((g.gpu_share ?? 0) * 100) }) : undefined,
    };
  };
  const deployedParts: Part[] = [];
  if (!deployedAt) {
    deployedParts.push(
      { key: "d-web", icon: "◫", name: "statusDeployedWeb", health: "checking", lines: [] },
      { key: "d-voice", icon: "⇄", name: "statusDeployedWebVoice", health: "checking", lines: [] },
      { key: "d-gemma", icon: "✦", name: "statusDeployedGemma", health: "checking", lines: [] },
      { key: "d-backend", icon: "◎", name: "statusDeployedBackend", health: "checking", lines: [] },
    );
  } else if (!deployed) {
    deployedParts.push({ key: "d-check", icon: "◎", name: "statusDeployedBackend", health: "warn", lines: [], error: deployedError ?? undefined });
  } else {
    const { web, web_voice: wv, backend: b } = deployed;
    deployedParts.push(
      { key: "d-web", icon: "◫", name: "statusDeployedWeb", health: web.ok ? "ok" : "down", lines: [deployed.site_url.replace(/^https?:\/\//, ""), ms(web.ms)], error: web.error },
      {
        key: "d-voice",
        icon: "⇄",
        name: "statusDeployedWebVoice",
        health: wv.ok ? "ok" : wv.reachable ? "warn" : "down", // reachable but its model isn't loaded: a warning
        lines: lines(wv.ok && wv.device, wv.ok && wv.busy && tr("statusBusy"), ms(wv.ms)),
        error: wv.error,
      },
      deployedGemma(b),
      {
        key: "d-backend",
        icon: "◎",
        name: "statusDeployedBackend",
        health: b.ok ? "ok" : "down",
        lines: b.ok
          ? lines(tr("statusQueue", { n: b.queue_length ?? 0 }), ms(b.ms), b.has_status_check === false && tr("statusNoStatusCheck"))
          : [],
        error: b.error,
      },
    );
  }

  const parts = view === "this" ? thisParts : deployedParts;
  return (
    <section className="admin-overview admin-status" aria-labelledby="admin-status-heading" aria-busy={checking}>
      <div className="admin-overview-heading">
        <div>
          <p className="admin-eyebrow">{tr("statusEyebrow")}</p>
          <h2 id="admin-status-heading" className="ui-section">{tr("statusTitle")}</h2>
        </div>
        <button
          type="button"
          className="ui-btn"
          onClick={() => void (view === "this" ? load() : loadDeployed())}
          disabled={checking || testing}
        >
          {checking ? tr("statusChecking") : tr("statusCheckNow")}
        </button>
      </div>

      {local && (
        <div className="admin-status-views" role="group" aria-label={tr("statusViewsLabel")}>
          {(["this", "deployed"] as const).map((v) => (
            <button key={v} type="button" className={view === v ? "is-selected" : ""} aria-pressed={view === v} onClick={() => setView(v)}>
              {tr(v === "this" ? "statusViewThis" : "statusViewDeployed")}
            </button>
          ))}
        </div>
      )}

      <Summary
        parts={parts}
        checkedAt={view === "this" ? checkedAt : deployedAt}
        note={view === "deployed" ? tr("statusDeployedWaking") : undefined}
      />

      <div className="admin-stat-grid">
        {parts.map((part) => (
          <PartCard key={part.key} part={part} />
        ))}
      </div>

      {view === "this" ? (
        <article className={`ui-card admin-activity-card admin-gemma-test${gemmaTest ? ` is-${gemmaTest.ok ? "ok" : "down"}` : ""}`}>
          <div className="admin-activity-heading">
            <div>
              <h3 className="ui-section">{tr("statusGemmaTestTitle")}</h3>
              <p className="ui-help">{tr("statusGemmaTestHint")}</p>
            </div>
            <button type="button" className="ui-btn" onClick={() => void load(true)} disabled={testing || checking || !status?.ollama.ok}>
              {testing ? tr("statusGemmaTesting") : tr("statusGemmaTest")}
            </button>
          </div>
          {gemmaTest && (
            <p className="admin-gemma-result" role="status">
              <span className="admin-status-light" aria-hidden="true" />
              {gemmaTest.ok
                ? tr("statusGemmaAnswered", { s: (gemmaTest.ms / 1000).toFixed(1), rate: gemmaTest.tokens_per_s ?? "–" })
                : tr("statusGemmaFailed", { error: gemmaTest.error ?? "" })}
            </p>
          )}
        </article>
      ) : (
        <article className="ui-card admin-activity-card">
          <p className="ui-help admin-deployed-note">{tr("statusDeployedNote")}</p>
          {deployed && (
            <a className="ui-btn" href={`${deployed.site_url}/admin`} target="_blank" rel="noreferrer">
              {tr("statusDeployedOpen")}
            </a>
          )}
        </article>
      )}
    </section>
  );
}
