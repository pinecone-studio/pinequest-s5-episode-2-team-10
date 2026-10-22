"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/format";
import type { Report, SlideText } from "@/lib/types";

// What was uploaded for this attempt: recording, script and slides.
export default function Uploads({ report }: { report: Report }) {
  const id = report.session_id;
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioError, setAudioError] = useState<string | null>(null);
  const [slides, setSlides] = useState<SlideText[] | null>(null);
  const [slidesError, setSlidesError] = useState<string | null>(null);

  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    api.audioBlob(id).then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setAudioUrl(url);
      },
      (e) => !cancelled && setAudioError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  async function toggleSlides() {
    if (slides) return setSlides(null);
    try {
      setSlides((await api.slidesText(id)).slides);
    } catch (e) {
      setSlidesError(errorMessage(e));
    }
  }

  async function downloadSlides() {
    try {
      const blob = await api.slidesFile(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = report.slides_filename ?? "slides";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setSlidesError(errorMessage(e));
    }
  }

  return (
    <section className="space-y-4 rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
      <h2 className="font-medium">Your uploads</h2>

      <div>
        <h3 className="mb-1 text-xs text-zinc-500">Recording</h3>
        {audioUrl ? (
          <audio controls src={audioUrl} className="h-9 w-full" />
        ) : (
          <p className="text-zinc-500">{audioError ?? "Loading recording…"}</p>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs text-zinc-500">Slides</h3>
        {report.slides_filename ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{report.slides_filename}</span>
              <button type="button" onClick={toggleSlides} className="text-zinc-500 underline">
                {slides ? "Hide text" : "Show text"}
              </button>
              <button type="button" onClick={downloadSlides} className="text-zinc-500 underline">
                Download
              </button>
            </div>
            {slidesError && <p className="mt-1 text-red-600">{slidesError}</p>}
            {slides && (
              <ol className="mt-2 space-y-2">
                {slides.map((s) => (
                  <li key={s.number} className="rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
                    <span className="text-xs text-zinc-500">Slide {s.number}</span>
                    <p className="whitespace-pre-line">{s.image_only ? <em className="text-zinc-400">Image only</em> : s.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <p className="text-zinc-500">No slides for this attempt.</p>
        )}
      </div>

      <div>
        <h3 className="mb-1 text-xs text-zinc-500">Script</h3>
        {report.script ? (
          <p className="max-h-48 overflow-y-auto whitespace-pre-line rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
            {report.script}
          </p>
        ) : (
          <p className="text-zinc-500">No script for this attempt.</p>
        )}
      </div>
    </section>
  );
}
