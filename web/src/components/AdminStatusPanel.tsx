"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage, formatDate } from "@/lib/format";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { routeHeaders } from "@/lib/routeAccess";
import type { AdminStatus } from "@/lib/types";

const REFRESH_MS = 30_000;

type Health = "ok" | "warn" | "down" | "unknown";

interface Part {
  key: string;
  icon: string;
  name: MessageKey;
  health: Health;
  lines: string[]; // details, one per line
}

/** The web server's own link to the voice server (GET /api/transcribe), used for live transcription. */
interface WebVoice {
  ok: boolean;
  device?: string;
  modelLoaded?: boolean;
  busy?: boolean;
  error?: string;
}

const HEALTH_LABEL: Record<Health, MessageKey> = {
  ok: "statusOk",
  warn: "statusWarn",
  down: "statusDown",
  unknown: "statusUnknown",
};

async function webVoice(): Promise<WebVoice | null> {
  try {
    const res = await fetch("/api/transcribe", { headers: routeHeaders(), cache: "no-store" });
    return (await res.json()) as WebVoice;
  } catch {
    return null;
  }
}

const lines = (...parts: (string | false | null | undefined)[]) => parts.filter((p): p is string => Boolean(p));

/** Admin "Status" tab: is every part the app needs up and working. Refreshes every 30 s. */
export default function AdminStatusPanel() {
  const { tr } = useLang();
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [voice, setVoice] = useState<WebVoice | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [testing, setTesting] = useState(false);
  const [gemmaTest, setGemmaTest] = useState<AdminStatus["gemma_test"]>(null);

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

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [load]);

  const ms = (n: number) => tr("statusMs", { ms: n });
  const where = (w: "local" | "remote") => tr(w === "local" ? "statusLocal" : "statusRemote");
  const parts: Part[] = [
    { key: "web", icon: "◫", name: "statusWeb", health: "ok", lines: [tr("statusWebDetail")] },
    voice?.ok
      ? {
          key: "web-voice",
          icon: "⇄",
          name: "statusWebVoice",
          health: voice.modelLoaded ? (voice.busy ? "warn" : "ok") : "down",
          lines: lines(voice.modelLoaded ? tr("statusModelLoaded") : tr("statusModelNotLoaded"), voice.device, voice.busy && tr("statusBusy")),
        }
      : { key: "web-voice", icon: "⇄", name: "statusWebVoice", health: checkedAt ? "down" : "unknown", lines: [voice?.error ?? tr("statusUnreachable")] },
  ];
  if (!status) {
    const needsBackend = (key: string, icon: string, name: MessageKey): Part => ({ key, icon, name, health: "unknown", lines: [tr("statusNeedsBackend")] });
    parts.push(
      { key: "backend", icon: "◎", name: "statusBackend", health: checkedAt ? "down" : "unknown", lines: [backendError ?? tr("statusChecking")] },
      needsBackend("database", "▤", "statusDatabase"),
      needsBackend("voice", "◉", "statusVoice"),
      needsBackend("gemma", "✦", "statusGemma"),
    );
  } else {
    const { backend, database, voice: v, ollama: o } = status;
    const partOnGpu = o.gpu_share != null && o.gpu_share < 1;
    parts.push(
      {
        key: "backend",
        icon: "◎",
        name: "statusBackend",
        health: "ok",
        lines: [backend.analysing ? tr("statusAnalysing") : tr("statusIdle"), tr("statusQueue", { n: backend.queue_length })],
      },
      {
        key: "database",
        icon: "▤",
        name: "statusDatabase",
        health: database.ok ? "ok" : "down",
        lines: lines(database.ok ? ms(database.ms) : database.error),
      },
      {
        key: "voice",
        icon: "◉",
        name: "statusVoice",
        health: !v.ok ? (v.used ? "down" : "warn") : v.busy || !v.cuda ? "warn" : "ok",
        lines: v.ok
          ? lines(v.device, !v.cuda && tr("statusCpu"), v.busy && tr("statusBusy"), `${where(v.where)} · ${ms(v.ms)}`, !v.used && tr("statusVoiceUnused"))
          : lines(v.error, where(v.where), !v.used && tr("statusVoiceUnused")),
      },
      {
        key: "gemma",
        icon: "✦",
        name: "statusGemma",
        health: !o.ok ? "down" : partOnGpu ? "warn" : "ok",
        lines: o.ok
          ? lines(
              o.model,
              o.loaded ? tr("statusModelLoaded") : tr("statusModelNotLoadedGemma"),
              partOnGpu && tr("statusGpuShare", { pct: Math.round((o.gpu_share ?? 0) * 100) }),
              `${where(o.where)} · ${ms(o.ms)}`,
            )
          : lines(o.error, where(o.where)),
      },
    );
  }

  const down = parts.filter((p) => p.health === "down").length;
  const warn = parts.filter((p) => p.health === "warn").length;
  const overall: Health = !checkedAt ? "unknown" : down ? "down" : warn ? "warn" : "ok";
  return (
    <section className="admin-overview admin-status" aria-labelledby="admin-status-heading" aria-busy={checking}>
      <div className="admin-overview-heading">
        <div>
          <p className="admin-eyebrow">{tr("statusEyebrow")}</p>
          <h2 id="admin-status-heading" className="ui-section">{tr("statusTitle")}</h2>
        </div>
        <button type="button" className="ui-btn" onClick={() => void load()} disabled={checking || testing}>
          {checking ? tr("statusChecking") : tr("statusCheckNow")}
        </button>
      </div>

      <div className={`ui-card admin-status-summary is-${overall}`} role="status">
        <span className="admin-status-light" aria-hidden="true" />
        <div>
          <strong>
            {!checkedAt
              ? tr("statusChecking")
              : down
                ? tr("statusSomeDown", { n: down })
                : warn
                  ? tr("statusSomeWarn", { n: warn })
                  : tr("statusAllOk")}
          </strong>
          {checkedAt && <span>{tr("statusCheckedAt", { time: formatDate(checkedAt) })} · {tr("statusAutoRefresh")}</span>}
        </div>
      </div>

      <div className="admin-stat-grid">
        {parts.map((part) => (
          <article key={part.key} className={`ui-card admin-stat-card admin-service is-${part.health}`}>
            <div className="admin-service-head">
              <span className="admin-stat-icon" aria-hidden="true">{part.icon}</span>
              <span className="admin-status-light" aria-hidden="true" />
            </div>
            <p>{tr(part.name)}</p>
            <strong>{tr(HEALTH_LABEL[part.health])}</strong>
            {part.lines.map((line, i) => (
              <span key={i} className="admin-stat-foot">{line}</span>
            ))}
          </article>
        ))}
      </div>

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
    </section>
  );
}
