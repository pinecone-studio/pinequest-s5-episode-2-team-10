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
    <section className="ui-card space-y-4 text-sm">
      <h2 className="ui-section">Your uploads</h2>

      <div>
        <h3 className="ui-help mb-1">Recording</h3>
        {audioUrl ? (
          <audio controls src={audioUrl} className="h-9 w-full" />
        ) : (
          <p className="ui-muted">{audioError ?? "Loading recording…"}</p>
        )}
      </div>

      <div>
        <h3 className="ui-help mb-1">Slides</h3>
        {report.slides_filename ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-medium">{report.slides_filename}</span>
              <button type="button" onClick={toggleSlides} className="ui-link">
                {slides ? "Hide text" : "Show text"}
              </button>
              <button type="button" onClick={downloadSlides} className="ui-link">
                Download
              </button>
            </div>
            {slidesError && <p className="ui-alert mt-1">{slidesError}</p>}
            {slides && (
              <ol className="mt-2 space-y-2">
                {slides.map((s) => (
                  <li key={s.number} className="ui-inset">
                    <span className="ui-help">Slide {s.number}</span>
                    <p className="whitespace-pre-line">{s.image_only ? <em className="ui-help">Image only</em> : s.text}</p>
                  </li>
                ))}
              </ol>
            )}
          </>
        ) : (
          <p className="ui-muted">No slides for this attempt.</p>
        )}
      </div>

      <div>
        <h3 className="ui-help mb-1">Script</h3>
        {report.script ? (
          <p className="ui-inset max-h-48 overflow-y-auto whitespace-pre-line">{report.script}</p>
        ) : (
          <p className="ui-muted">No script for this attempt.</p>
        )}
      </div>
    </section>
  );
}
