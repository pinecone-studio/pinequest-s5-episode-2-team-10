"use client";

import { useEffect, useRef, useState } from "react";
import { formatTime } from "@/lib/format";

export interface AudioValue {
  blob: Blob;
  filename: string;
  durationS: number;
  url: string;
}

const MAX_SECONDS = 5 * 60;
const MAX_BYTES = 25 * 1024 * 1024;
const ACCEPT = ".wav,.mp3,.m4a,.webm,.ogg,audio/*";

function pickMimeType(): string {
  const options = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
}

function readDuration(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    const el = new Audio(URL.createObjectURL(blob));
    el.onloadedmetadata = () => resolve(el.duration);
    el.onerror = () => resolve(NaN);
  });
}

export default function AudioInput({
  value,
  onChange,
}: {
  value: AudioValue | null;
  onChange: (v: AudioValue | null) => void;
}) {
  const [mode, setMode] = useState<"upload" | "record">("upload");
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => stopTimer(), []);

  function stopTimer() {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }

  async function handleFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (file.size > MAX_BYTES) {
      setError("File is larger than 25 MB.");
      return;
    }
    const durationS = await readDuration(file);
    if (Number.isFinite(durationS) && durationS > MAX_SECONDS + 1) {
      setError(`Audio is ${formatTime(durationS)} long. The limit is 5:00.`);
      return;
    }
    onChange({
      blob: file,
      filename: file.name,
      durationS: Number.isFinite(durationS) ? durationS : 0,
      url: URL.createObjectURL(file),
    });
  }

  async function startRecording() {
    setError(null);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("Microphone access was blocked. Allow it in the browser, or upload a file.");
      return;
    }

    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    const startedAt = Date.now();

    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      stopTimer();
      setRecording(false);
      const type = recorder.mimeType || "audio/webm";
      const blob = new Blob(chunks, { type });
      const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
      // Browser WebM recordings often report no duration, so use wall-clock time.
      onChange({
        blob,
        filename: `recording.${ext}`,
        durationS: (Date.now() - startedAt) / 1000,
        url: URL.createObjectURL(blob),
      });
    };

    recorderRef.current = recorder;
    recorder.start(1000);
    setRecording(true);
    setElapsed(0);
    onChange(null);

    timerRef.current = window.setInterval(() => {
      const s = (Date.now() - startedAt) / 1000;
      setElapsed(s);
      if (s >= MAX_SECONDS) recorder.stop();
    }, 250);
  }

  function stopRecording() {
    recorderRef.current?.stop();
  }

  return (
    <div className="space-y-3">
      <div className="ui-tabs">
        {(["upload", "record"] as const).map((m) => (
          <button
            key={m}
            type="button"
            disabled={recording}
            onClick={() => setMode(m)}
            className={mode === m ? "ui-tab is-on" : "ui-tab"}
          >
            {m}
          </button>
        ))}
      </div>

      {mode === "upload" ? (
        <label className="ui-drop flex cursor-pointer flex-col items-center gap-1 px-4 py-5 text-center text-sm">
          <span className="font-medium">Choose an audio file</span>
          <span className="ui-help">WAV, MP3, M4A, WebM or OGG · up to 25 MB and 5 minutes</span>
          <input
            type="file"
            accept={ACCEPT}
            className="sr-only"
            onChange={(e) => {
              handleFile(e.target.files?.[0]);
              e.target.value = ""; // so picking the same file again still fires
            }}
          />
        </label>
      ) : (
        <div className="ui-panel flex items-center gap-4 px-4 py-3">
          <button
            type="button"
            onClick={recording ? stopRecording : startRecording}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[#151617] ${
              recording ? "bg-[#c48b94]" : "bg-[#e6e6e6]"
            }`}
            aria-label={recording ? "Stop recording" : "Start recording"}
          >
            {recording ? (
              <span className="h-3.5 w-3.5 rounded-sm bg-[#151617]" />
            ) : (
              <span className="h-3.5 w-3.5 rounded-full bg-[#c48b94]" />
            )}
          </button>
          <div className="text-sm">
            {recording ? (
              <>
                <div className="font-medium tabular-nums">
                  Recording {formatTime(elapsed)} / 5:00
                </div>
                <div className="ui-help">Click the button to stop.</div>
              </>
            ) : (
              <>
                <div className="font-medium">Record your pitch</div>
                <div className="ui-help">Stops automatically at 5 minutes.</div>
              </>
            )}
          </div>
        </div>
      )}

      {value && !recording && (
        <div className="ui-inset flex flex-wrap items-center gap-3 text-sm">
          <audio controls src={value.url} className="h-9 max-w-full" />
          <span className="ui-muted">
            {value.filename} · {formatTime(value.durationS)}
          </span>
          <button type="button" onClick={() => onChange(null)} className="ui-link ml-auto">
            Remove
          </button>
        </div>
      )}

      {error && <p className="ui-alert">{error}</p>}
    </div>
  );
}
