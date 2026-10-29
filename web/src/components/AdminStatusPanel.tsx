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

interface Row {
  key: string;
  name: MessageKey;
  health: Health;
  detail: string;
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
  const unknown = (key: string, name: MessageKey): Row => ({ key, name, health: "unknown", detail: tr("statusNeedsBackend") });
  const rows: Row[] = [
    { key: "web", name: "statusWeb", health: "ok", detail: tr("statusWebDetail") },
    voice
      ? {
          key: "web-voice",
          name: "statusWebVoice",
          health: voice.ok && voice.modelLoaded ? (voice.busy ? "warn" : "ok") : "down",
          detail: voice.ok
            ? [voice.modelLoaded ? tr("statusModelLoaded") : tr("statusModelNotLoaded"), voice.device, voice.busy ? tr("statusBusy") : ""]
                .filter(Boolean)
                .join(" · ")
            : (voice.error ?? tr("statusUnreachable")),
        }
      : { key: "web-voice", name: "statusWebVoice", health: "down", detail: tr("statusUnreachable") },
  ];
  if (!status) {
    rows.push(
      { key: "backend", name: "statusBackend", health: checkedAt ? "down" : "unknown", detail: backendError ?? tr("loading") },
      unknown("database", "statusDatabase"),
      unknown("voice", "statusVoice"),
      unknown("gemma", "statusGemma"),
    );
  } else {
    const { backend, database, voice: v, ollama: o } = status;
    rows.push(
      {
        key: "backend",
        name: "statusBackend",
        health: "ok",
        detail: [backend.analysing ? tr("statusAnalysing") : tr("statusIdle"), tr("statusQueue", { n: backend.queue_length })].join(" · "),
      },
      { key: "database", name: "statusDatabase", health: database.ok ? "ok" : "down", detail: database.ok ? ms(database.ms) : (database.error ?? "") },
      {
        key: "voice",
        name: "statusVoice",
        health: !v.ok ? (v.used ? "down" : "warn") : v.busy || !v.cuda ? "warn" : "ok",
        detail: [
          v.ok ? [v.model, v.device, v.cuda ? "" : tr("statusCpu"), v.busy ? tr("statusBusy") : ""].filter(Boolean).join(" · ") : (v.error ?? ""),
          tr(v.where === "local" ? "statusLocal" : "statusRemote"),
          v.used ? "" : tr("statusVoiceUnused"),
          ms(v.ms),
        ].filter(Boolean).join(" · "),
      },
      {
        key: "gemma",
        name: "statusGemma",
        health: !o.ok ? "down" : o.gpu_share != null && o.gpu_share < 1 ? "warn" : "ok",
        detail: [
          o.ok
            ? [
                o.model,
                o.loaded ? tr("statusModelLoaded") : tr("statusModelNotLoadedGemma"),
                o.gpu_share != null && o.gpu_share < 1 ? tr("statusGpuShare", { pct: Math.round(o.gpu_share * 100) }) : "",
                o.version ? `Ollama ${o.version}` : "",
              ].filter(Boolean).join(" · ")
            : (o.error ?? ""),
          tr(o.where === "local" ? "statusLocal" : "statusRemote"),
          ms(o.ms),
        ].filter(Boolean).join(" · "),
      },
    );
  }

  const down = rows.filter((r) => r.health === "down").length;
  return (
    <section className="admin-status" aria-labelledby="admin-status-heading" aria-busy={checking}>
      <div className="admin-overview-heading">
        <div>
          <p className="admin-eyebrow">{tr("statusEyebrow")}</p>
          <h2 id="admin-status-heading" className="ui-section">{tr("statusTitle")}</h2>
        </div>
        <button type="button" className="ui-btn" onClick={() => void load()} disabled={checking || testing}>
          {checking ? tr("statusChecking") : tr("statusCheckNow")}
        </button>
      </div>

      <p className={`admin-status-summary ${down ? "is-down" : "is-ok"}`} role="status">
        {checkedAt ? (down ? tr("statusSomeDown", { n: down }) : tr("statusAllOk")) : tr("statusChecking")}
        {checkedAt && <span className="ui-muted"> · {tr("statusCheckedAt", { time: formatDate(checkedAt) })}</span>}
      </p>

      <ul className="admin-status-list">
        {rows.map((row) => (
          <li key={row.key} className={`admin-status-row is-${row.health}`}>
            <span className="admin-status-dot" aria-hidden="true" />
            <span className="admin-status-name">{tr(row.name)}</span>
            <span className="admin-status-state">{tr(HEALTH_LABEL[row.health])}</span>
            <span className="admin-status-detail">{row.detail}</span>
          </li>
        ))}
      </ul>

      <div className="admin-status-test">
        <div>
          <h3>{tr("statusGemmaTestTitle")}</h3>
          <p className="ui-muted">{tr("statusGemmaTestHint")}</p>
        </div>
        <button type="button" className="ui-btn" onClick={() => void load(true)} disabled={testing || checking || !status?.ollama.ok}>
          {testing ? tr("statusGemmaTesting") : tr("statusGemmaTest")}
        </button>
        {gemmaTest && (
          <p className={`admin-status-summary ${gemmaTest.ok ? "is-ok" : "is-down"}`} role="status">
            {gemmaTest.ok
              ? tr("statusGemmaAnswered", { s: (gemmaTest.ms / 1000).toFixed(1), rate: gemmaTest.tokens_per_s ?? "–" })
              : tr("statusGemmaFailed", { error: gemmaTest.error ?? "" })}
          </p>
        )}
      </div>
    </section>
  );
}
