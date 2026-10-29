"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { isLocalHost } from "@/lib/build";
import { errorMessage, formatDate } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { routeHeaders } from "@/lib/routeAccess";
import { loadHistory, recordChecks, saveHistory, span, type Health, type History, type PartHistory } from "@/lib/statusHistory";
import type { AdminStatus, DeployedStatus } from "@/lib/types";
import Modal from "./Modal";

const REFRESH_MS = 30_000;

type Tr = (key: MessageKey, vars?: Record<string, string | number>) => string;

// Green: working. Yellow: up but not working correctly (or can't be checked). Red: down.
// Grey only until the first check answers.
interface Part {
  key: string;
  icon: string;
  name: MessageKey;
  about: MessageKey; // what this part is
  health: Health;
  lines: string[]; // short details on the card
  error?: string; // what's wrong, in the card's colour
  facts: [string, string][]; // everything the check knows, for the dialog
  fix?: MessageKey; // what to do when it isn't working
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
const facts = (...rows: (readonly [string, string | number | null | undefined] | false)[]): [string, string][] =>
  rows
    .filter((r): r is readonly [string, string | number] => r !== false && r[1] != null && r[1] !== "")
    .map(([k, v]) => [k, String(v)]);

function duration(tr: Tr, from: string | null | undefined, to: string | null | undefined): string | null {
  const s = span(from, to);
  if (!s) return null;
  if (s.d) return tr("durationDH", { d: s.d, h: s.h });
  if (s.h) return tr("durationHM", { h: s.h, m: s.m });
  return tr("durationM", { m: s.m });
}

/** Ollama's "loaded until": far in the future means it's kept loaded for good. */
function loadedUntil(tr: Tr, until: string | null | undefined): string | null {
  if (!until) return null;
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return null;
  return new Date(t).getUTCFullYear() > 2100 ? tr("factKeptLoaded") : formatDate(until);
}

const yesNo = (tr: Tr, v: boolean | undefined) => (v == null ? null : tr(v ? "factYes" : "factNo"));
const pct = (share: number | null | undefined) => (share == null ? null : `${Math.round(share * 100)}%`);

// ---- This site: the backend the page uses, and this web server ------------------------------------

function thisParts(tr: Tr, host: string | null, status: AdminStatus | null, backendError: string | null, voice: WebVoice | null, checkedAt: string | null): Part[] {
  const ms = (n: number) => tr("statusMs", { ms: n });
  const where = (w: "local" | "remote") => tr(w === "local" ? "statusLocal" : "statusRemote");
  const parts: Part[] = [
    { key: "web", icon: "◫", name: "statusWeb", about: "aboutWeb", health: "ok", lines: lines(host), facts: facts([tr("factAddress"), host]) },
  ];

  const webVoicePart = { key: "web-voice", icon: "⇄", name: "statusWebVoice" as MessageKey, about: "aboutWebVoice" as MessageKey, fix: "fixVoice" as MessageKey };
  if (!checkedAt) parts.push({ ...webVoicePart, health: "checking", lines: [], facts: [] });
  else if (!voice || !voice.ok) parts.push({ ...webVoicePart, health: "down", lines: [], error: voice?.error ?? tr("statusUnreachable"), facts: [] });
  else {
    parts.push({
      ...webVoicePart,
      health: voice.modelLoaded ? "ok" : "warn",
      lines: lines(voice.device, voice.busy && tr("statusBusy")),
      error: voice.modelLoaded ? undefined : tr("statusModelNotLoaded"),
      facts: facts([tr("factDevice"), voice.device], [tr("factModelLoaded"), yesNo(tr, voice.modelLoaded)], [tr("factBusy"), yesNo(tr, voice.busy)]),
    });
  }

  if (!status) {
    const pending: Health = checkedAt ? "warn" : "checking";
    const cantCheck = checkedAt ? tr("statusNeedsBackend") : undefined;
    parts.push(
      { key: "backend", icon: "◎", name: "statusBackend", about: "aboutBackend", health: checkedAt ? "down" : "checking", lines: [], error: backendError ?? undefined, facts: [], fix: "fixBackend" },
      { key: "database", icon: "▤", name: "statusDatabase", about: "aboutDatabase", health: pending, lines: [], error: cantCheck, facts: [], fix: "fixBackend" },
      { key: "voice", icon: "◉", name: "statusVoice", about: "aboutVoice", health: pending, lines: [], error: cantCheck, facts: [], fix: "fixBackend" },
      { key: "gemma", icon: "✦", name: "statusGemma", about: "aboutGemma", health: pending, lines: [], error: cantCheck, facts: [], fix: "fixBackend" },
    );
    return parts;
  }

  const { backend, database, voice: v, ollama: o } = status;
  const partOnCpu = o.gpu_share != null && o.gpu_share < 1;
  parts.push(
    {
      key: "backend",
      icon: "◎",
      name: "statusBackend",
      about: "aboutBackend",
      health: "ok",
      lines: [backend.analysing ? tr("statusAnalysing") : tr("statusIdle"), tr("statusQueue", { n: backend.queue_length })],
      facts: facts(
        [tr("factAnalysing"), yesNo(tr, backend.analysing)],
        [tr("factQueue"), backend.queue_length],
        [tr("factDefaultModel"), backend.default_model],
        [tr("factStarted"), backend.started_at && formatDate(backend.started_at)],
        [tr("factUptime"), duration(tr, backend.started_at, checkedAt)],
      ),
      fix: "fixBackend",
    },
    {
      key: "database",
      icon: "▤",
      name: "statusDatabase",
      about: "aboutDatabase",
      health: database.ok ? "ok" : "down",
      lines: database.ok ? [ms(database.ms)] : [],
      error: database.error,
      facts: facts([tr("factResponse"), ms(database.ms)]),
      fix: "fixDatabase",
    },
    {
      key: "voice",
      icon: "◉",
      name: "statusVoice",
      about: "aboutVoice",
      // Down only matters when the analysis uses it; otherwise it's a warning.
      health: !v.ok ? (v.used ? "down" : "warn") : !v.cuda ? "warn" : "ok",
      lines: lines(v.ok && v.device, v.ok && v.busy && tr("statusBusy"), `${where(v.where)} · ${ms(v.ms)}`, !v.used && tr("statusVoiceUnused")),
      error: !v.ok ? v.error : !v.cuda ? tr("statusCpu") : undefined,
      facts: facts(
        [tr("factModel"), v.model],
        [tr("factDevice"), v.device],
        [tr("factGpu"), yesNo(tr, v.cuda)],
        [tr("factModelLoaded"), yesNo(tr, v.model_loaded)],
        [tr("factBusy"), yesNo(tr, v.busy)],
        [tr("factWhere"), where(v.where)],
        [tr("factUsedByAnalysis"), yesNo(tr, v.used)],
        [tr("factSpeechMode"), v.asr_backend],
        [tr("factStarted"), v.started_at && formatDate(v.started_at)],
        [tr("factUptime"), duration(tr, v.started_at, checkedAt)],
        [tr("factResponse"), ms(v.ms)],
      ),
      fix: !v.ok ? "fixVoice" : !v.cuda ? "fixCpu" : undefined,
    },
    {
      key: "gemma",
      icon: "✦",
      name: "statusGemma",
      about: "aboutGemma",
      health: !o.ok ? "down" : partOnCpu ? "warn" : "ok",
      lines: lines(o.ok && o.model, o.ok && (o.loaded ? tr("statusModelLoaded") : tr("statusModelNotLoadedGemma")), `${where(o.where)} · ${ms(o.ms)}`),
      error: !o.ok ? o.error : partOnCpu ? tr("statusGpuShare", { pct: Math.round((o.gpu_share ?? 0) * 100) }) : undefined,
      facts: facts(
        [tr("factModel"), o.model],
        [tr("factInstalled"), yesNo(tr, o.installed)],
        [tr("factModelLoaded"), yesNo(tr, o.loaded)],
        [tr("factOnGpu"), pct(o.gpu_share)],
        [tr("factSize"), o.size_gb != null ? `${o.size_gb} GB` : null],
        [tr("factLoadedUntil"), loadedUntil(tr, o.loaded_until)],
        [tr("factVersion"), o.version ? `Ollama ${o.version}` : null],
        [tr("factWhere"), where(o.where)],
        [tr("factResponse"), ms(o.ms)],
      ),
      fix: !o.ok ? "fixGemma" : partOnCpu ? "fixCpu" : undefined,
    },
  );
  return parts;
}

// ---- The deployed site, checked by the backend this page uses ----------------------------------

type GemmaReport = DeployedStatus["tunnel_gemma"] | NonNullable<DeployedStatus["backend"]["gemma"]> | null;

function deployedParts(tr: Tr, deployed: DeployedStatus | null, deployedError: string | null, deployedAt: string | null): Part[] {
  const ms = (n: number) => tr("statusMs", { ms: n });
  const shells: [string, string, MessageKey, MessageKey][] = [
    ["d-web", "◫", "statusDeployedWeb", "aboutDeployedWeb"],
    ["d-voice", "⇄", "statusDeployedWebVoice", "aboutDeployedWebVoice"],
    ["d-backend", "◎", "statusDeployedBackend", "aboutDeployedBackend"],
    ["d-gemma", "✦", "statusDeployedGemma", "aboutDeployedGemma"],
    ["t-voice", "◉", "statusTunnelVoice", "aboutTunnelVoice"],
    ["t-gemma", "✦", "statusTunnelGemma", "aboutTunnelGemma"],
  ];
  if (!deployedAt) return shells.map(([key, icon, name, about]) => ({ key, icon, name, about, health: "checking", lines: [], facts: [] }));
  if (!deployed) {
    return [{ key: "d-check", icon: "◎", name: "statusDeployedBackend", about: "aboutDeployedBackend", health: "warn", lines: [], error: deployedError ?? undefined, facts: [] }];
  }

  const { web, web_voice: wv, backend: b, tunnel_voice: tv, tunnel_gemma: tg } = deployed;
  const gemmaPart = (key: string, name: MessageKey, about: MessageKey, g: GemmaReport, missing: string, extra: [string, string][] = []): Part => {
    if (!g) return { key, icon: "✦", name, about, health: "warn", lines: [], error: missing, facts: [] };
    const partOnCpu = g.gpu_share != null && g.gpu_share < 1;
    return {
      key,
      icon: "✦",
      name,
      about,
      health: !g.ok ? "down" : partOnCpu ? "warn" : "ok",
      lines: lines(g.model, g.ok && (g.loaded ? tr("statusModelLoaded") : tr("statusModelNotLoadedGemma"))),
      error: !g.ok ? g.error : partOnCpu ? tr("statusGpuShare", { pct: Math.round((g.gpu_share ?? 0) * 100) }) : undefined,
      facts: [
        ...facts(
          [tr("factModel"), g.model],
          [tr("factInstalled"), yesNo(tr, g.installed)],
          [tr("factModelLoaded"), yesNo(tr, g.loaded)],
          [tr("factOnGpu"), pct(g.gpu_share)],
          [tr("factLoadedUntil"), loadedUntil(tr, g.loaded_until)],
        ),
        ...extra,
      ],
      fix: !g.ok ? "fixGemma" : partOnCpu ? "fixCpu" : undefined,
    };
  };

  const parts: Part[] = [
    {
      key: "d-web",
      icon: "◫",
      name: "statusDeployedWeb",
      about: "aboutDeployedWeb",
      health: web.ok ? "ok" : "down",
      lines: [deployed.site_url.replace(/^https?:\/\//, ""), ms(web.ms)],
      error: web.error,
      facts: facts([tr("factAddress"), deployed.site_url], [tr("factResponse"), ms(web.ms)]),
      fix: "fixDeployedWeb",
    },
    {
      key: "d-voice",
      icon: "⇄",
      name: "statusDeployedWebVoice",
      about: "aboutDeployedWebVoice",
      health: wv.ok ? "ok" : wv.reachable ? "warn" : "down", // reachable but its model isn't loaded: a warning
      lines: lines(wv.ok && wv.device, wv.ok && wv.busy && tr("statusBusy"), ms(wv.ms)),
      error: wv.error,
      facts: facts([tr("factDevice"), wv.device], [tr("factModelLoaded"), yesNo(tr, wv.model_loaded)], [tr("factBusy"), yesNo(tr, wv.busy)], [tr("factResponse"), ms(wv.ms)]),
      fix: "fixDeployedVoice",
    },
    {
      key: "d-backend",
      icon: "◎",
      name: "statusDeployedBackend",
      about: "aboutDeployedBackend",
      health: b.ok ? "ok" : "down",
      lines: b.ok ? lines(tr("statusQueue", { n: b.queue_length ?? 0 }), ms(b.ms), b.has_status_check === false && tr("statusNoStatusCheck")) : [],
      error: b.error,
      facts: facts(
        [tr("factQueue"), b.queue_length],
        [tr("factSpeechMode"), b.asr],
        [tr("factDefaultModel"), b.default_backend],
        [tr("factStatusCheck"), yesNo(tr, b.has_status_check)],
        [tr("factResponse"), ms(b.ms)],
      ),
      fix: "fixDeployedBackend",
    },
    b.ok
      ? gemmaPart("d-gemma", "statusDeployedGemma", "aboutDeployedGemma", b.gemma ?? null, tr("statusGemmaNotReported"))
      : { key: "d-gemma", icon: "✦", name: "statusDeployedGemma", about: "aboutDeployedGemma", health: "warn", lines: [], error: tr("statusNeedsDeployedBackend"), facts: [] },
  ];

  if (tv) {
    parts.push({
      key: "t-voice",
      icon: "◉",
      name: "statusTunnelVoice",
      about: "aboutTunnelVoice",
      // Answering but with its model not loaded is a warning; not answering at all is down.
      health: !tv.ok ? (tv.model_loaded === false ? "warn" : "down") : !tv.cuda ? "warn" : "ok",
      lines: lines(tv.ok && tv.device, tv.ok && tv.busy && tr("statusBusy"), tv.host, ms(tv.ms)),
      error: !tv.ok ? tv.error : !tv.cuda ? tr("statusCpu") : undefined,
      facts: facts(
        [tr("factAddress"), tv.host],
        [tr("factDevice"), tv.device],
        [tr("factGpu"), yesNo(tr, tv.cuda)],
        [tr("factModelLoaded"), yesNo(tr, tv.model_loaded)],
        [tr("factBusy"), yesNo(tr, tv.busy)],
        [tr("factStarted"), tv.started_at && formatDate(tv.started_at)],
        [tr("factUptime"), duration(tr, tv.started_at, deployedAt)],
        [tr("factResponse"), ms(tv.ms)],
      ),
      fix: !tv.ok ? "fixTunnel" : !tv.cuda ? "fixCpu" : undefined,
    });
  }
  if (tg) {
    parts.push(gemmaPart("t-gemma", "statusTunnelGemma", "aboutTunnelGemma", tg, tr("statusUnreachable"), facts([tr("factAddress"), tg.host], [tr("factResponse"), ms(tg.ms)])));
  }
  return parts;
}

// ---- Cards and dialogs ---------------------------------------------------------------------------

function PartCard({ part, onOpen }: { part: Part; onOpen: () => void }) {
  const { tr } = useLang();
  return (
    <button type="button" className={`ui-card admin-stat-card admin-service is-${part.health}`} onClick={onOpen} aria-haspopup="dialog">
      <span className="admin-service-head">
        <span className="admin-stat-icon" aria-hidden="true">{part.icon}</span>
        <span className="admin-status-light" role="img" aria-label={tr(HEALTH_LABEL[part.health])} />
      </span>
      <strong>{tr(part.name)}</strong>
      {part.error && <span className="admin-service-error">{part.error}</span>}
      {part.lines.map((line, i) => (
        <span key={i} className="admin-stat-foot">{line}</span>
      ))}
      <span className="admin-service-more" aria-hidden="true">{tr("statusMore")} ›</span>
    </button>
  );
}

function PartDialog({ part, history, checkedAt, onClose }: { part: Part; history: PartHistory | undefined; checkedAt: string | null; onClose: () => void }) {
  const { tr } = useLang();
  const since = history ? duration(tr, history.since, checkedAt) : null;
  return (
    <Modal title={tr(part.name)} onClose={onClose} wide>
      <div className={`admin-status admin-part-dialog is-${part.health}`}>
        <p className="admin-part-state">
          <span className="admin-status-light" aria-hidden="true" />
          <strong>{tr(HEALTH_LABEL[part.health])}</strong>
          {since && <span className="ui-muted"> · {tr("historySince", { time: since })}</span>}
        </p>
        <p className="ui-help">{tr(part.about)}</p>

        {part.error && (
          <section className="admin-part-section admin-part-error">
            <h3>{tr("dialogError")}</h3>
            <p>{part.error}</p>
            {part.fix && <p className="ui-help">{tr(part.fix)}</p>}
          </section>
        )}

        {part.facts.length > 0 && (
          <section className="admin-part-section">
            <h3>{tr("dialogDetails")}</h3>
            <dl className="admin-part-facts">
              {part.facts.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        <section className="admin-part-section">
          <h3>{tr("dialogHistory")}</h3>
          {!history ? (
            <p className="ui-help">{tr("historyNone")}</p>
          ) : (
            <>
              <dl className="admin-part-facts">
                <div>
                  <dt>{tr("historyLastOk")}</dt>
                  <dd>{history.lastOkAt ? formatDate(history.lastOkAt) : tr("historyNever")}</dd>
                </div>
                <div>
                  <dt>{tr("historyChecks")}</dt>
                  <dd>{tr("historyChecksValue", { n: history.checks, problems: history.problems })}</dd>
                </div>
                {history.lastError && (
                  <div>
                    <dt>{tr("historyLastError")}</dt>
                    <dd>
                      {history.lastErrorAt && `${formatDate(history.lastErrorAt)} · `}
                      {history.lastError}
                    </dd>
                  </div>
                )}
              </dl>
              <ul className="admin-part-changes">
                {history.changes.map((c, i) => (
                  <li key={i} className={`is-${c.to}`}>
                    <span className="admin-status-light" aria-hidden="true" />
                    <span className="admin-part-change-time">{formatDate(c.at)}</span>
                    <span>
                      {c.from ? `${tr(HEALTH_LABEL[c.from])} → ` : ""}
                      {tr(HEALTH_LABEL[c.to])}
                      {c.error ? ` · ${c.error}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="ui-help">{tr("historyNote")}</p>
            </>
          )}
        </section>
      </div>
    </Modal>
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
  const [open, setOpen] = useState<string | null>(null); // the part whose dialog is open
  const [history, setHistory] = useState<History>({});

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

  // Each round of checks goes into the history as it arrives.
  const remember = useCallback((parts: Part[], at: string) => {
    setHistory((h) => {
      const next = recordChecks(h, parts, at);
      saveHistory(next);
      return next;
    });
  }, []);

  const load = useCallback(
    async (testGemma = false) => {
      if (testGemma) setTesting(true);
      else setChecking(true);
      const [backend, web] = await Promise.all([
        api.adminStatus(testGemma).then(
          (s) => ({ ok: true as const, s }),
          (err: unknown) => ({ ok: false as const, message: errorMessage(err) }),
        ),
        webVoice(),
      ]);
      const at = new Date().toISOString();
      const s = backend.ok ? backend.s : null;
      const error = backend.ok ? null : backend.message;
      setStatus(s);
      setBackendError(error);
      if (testGemma && s) setGemmaTest(s.gemma_test);
      setVoice(web);
      setCheckedAt(at);
      remember(thisParts(tr, window.location.host, s, error, web, at), at);
      setChecking(false);
      setTesting(false);
    },
    [tr, remember],
  );

  const loadDeployed = useCallback(async () => {
    setChecking(true);
    let d: DeployedStatus | null = null;
    let error: string | null = null;
    try {
      d = await api.adminStatusDeployed(lang);
    } catch (err) {
      error = errorMessage(err);
    }
    const at = new Date().toISOString();
    setDeployed(d);
    setDeployedError(error);
    setDeployedAt(at);
    remember(deployedParts(tr, d, error, at), at);
    setChecking(false);
  }, [lang, tr, remember]);

  useEffect(() => {
    const first = window.setTimeout(() => {
      setPage({ host: window.location.host, hostname: window.location.hostname });
      setHistory(loadHistory());
    }, 0);
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

  const parts = view === "this" ? thisParts(tr, host, status, backendError, voice, checkedAt) : deployedParts(tr, deployed, deployedError, deployedAt);
  const openPart = parts.find((p) => p.key === open) ?? null;
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
          <PartCard key={part.key} part={part} onOpen={() => setOpen(part.key)} />
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

      {openPart &&
        createPortal(
          <PartDialog part={openPart} history={history[openPart.key]} checkedAt={view === "this" ? checkedAt : deployedAt} onClose={() => setOpen(null)} />,
          document.body,
        )}
    </section>
  );
}
