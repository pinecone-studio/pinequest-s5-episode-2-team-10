"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { figmaEmbedUrl } from "@/lib/figmaEmbed";
import {
  folderSnapshot,
  getFolderBlob,
  serverFolderSnapshot,
  slideKey,
  subscribeFolders,
} from "@/lib/folderStore";
import { useLang } from "@/lib/i18nClient";
import { postPresent, subscribePresentAll, type PresentMode, type PresentState } from "@/lib/presentSync";
import { openPdf, paintPage } from "@/lib/slidePdf";

function isPdf(file: Blob) {
  return file.type === "application/pdf" || /\.pdf$/i.test((file as File).name ?? "");
}

function isCancel(err: unknown) {
  return err instanceof Error && /cancel/i.test(err.message);
}

type Props = { folderId: string; wantFullscreen?: boolean };

/** Audience-only slide surface for dual-screen Present mode. */
export default function PresentView({ folderId: initialFolderId, wantFullscreen = false }: Props) {
  const { tr } = useLang();
  const folders = useSyncExternalStore(subscribeFolders, folderSnapshot, serverFolderSnapshot);

  const [activeFolderId, setActiveFolderId] = useState(initialFolderId);
  const folder = folders.find((f) => f.id === activeFolderId) ?? null;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const slideGen = useRef(0);
  const urlRef = useRef<string | null>(null);
  const pendingStateRef = useRef<PresentState | null>(null);
  const gotStateRef = useRef(false);
  const lastSeqRef = useRef(0);
  const lastSeqFolderRef = useRef<string | null>(null);

  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [slidePdf, setSlidePdf] = useState(false);
  const [hasSlide, setHasSlide] = useState(false);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [shownPages, setShownPages] = useState<number[]>([]);
  const [mode, setMode] = useState<PresentMode>("pdf");
  const [figmaUrl, setFigmaUrl] = useState<string | null>(null);
  const [slideRev, setSlideRev] = useState(0);
  const [pdfEpoch, setPdfEpoch] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [isFs, setIsFs] = useState(false);

  const figmaEmbed = figmaUrl ? figmaEmbedUrl(figmaUrl) : folder?.figmaUrl ? figmaEmbedUrl(folder.figmaUrl) : null;
  const showFigma = mode === "figma" && !!figmaEmbed;

  function rememberUrl(next: string | null) {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = next;
    setSlideUrl(next);
  }

  function applyState(state: PresentState) {
    const folderChanged = lastSeqFolderRef.current !== state.folderId;
    if (!folderChanged && state.seq <= lastSeqRef.current) return;
    lastSeqRef.current = state.seq;
    lastSeqFolderRef.current = state.folderId;
    pendingStateRef.current = state;
    gotStateRef.current = true;
    setPage(Math.max(1, state.page));
    setPageCount(Math.max(0, state.pageCount));
    setShownPages(state.shownPages ?? []);
    setMode(state.mode);
    if (state.figmaUrl !== undefined) setFigmaUrl(state.figmaUrl);
    if (state.folderId !== activeFolderId) setActiveFolderId(state.folderId);
    if (typeof state.slideRev === "number") setSlideRev(state.slideRev);
  }

  async function loadSlide(file: Blob) {
    const gen = ++slideGen.current;
    const pdf = isPdf(file);
    setHasSlide(true);
    const pending = pendingStateRef.current;
    const restore = !!pending && pending.folderId === (folder?.id ?? activeFolderId);

    if (!pdf) {
      await pdfRef.current?.loadingTask.destroy().catch(() => undefined);
      if (slideGen.current !== gen) return;
      pdfRef.current = null;
      setSlidePdf(false);
      if (restore) {
        setPage(Math.max(1, pending.page));
        setPageCount(pending.pageCount);
        setShownPages(pending.shownPages ?? []);
        setMode(pending.mode);
      } else {
        setPageCount(0);
        setShownPages([]);
        setPage(1);
      }
      rememberUrl(URL.createObjectURL(file));
      setNote(null);
      return;
    }
    setSlidePdf(true);
    setNote(null);
    rememberUrl(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const doc = await openPdf(bytes);
      if (slideGen.current !== gen) {
        await doc.loadingTask.destroy();
        return;
      }
      await pdfRef.current?.loadingTask.destroy().catch(() => undefined);
      pdfRef.current = doc;
      if (restore) {
        setPage(Math.max(1, pending.page));
        setPageCount(pending.pageCount || doc.numPages);
        setShownPages(pending.shownPages ?? []);
        setMode(pending.mode);
      } else {
        setPageCount(doc.numPages);
        setShownPages([]);
        setPage(1);
      }
      setPdfEpoch((n) => n + 1);
    } catch {
      if (slideGen.current !== gen) return;
      setNote(tr("pdfOpenFail"));
    }
  }

  // Load (or reload) slide bytes when the active folder or slideRev from the presenter changes.
  // Page-only updates do not change slideRev, so this effect stays idle while flipping slides.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!folder) {
        setHasSlide(false);
        return;
      }
      const slide = await getFolderBlob(folder.slide?.storageKey ?? slideKey(folder.id));
      if (cancelled) return;
      if (slide) await loadSlide(slide);
      else {
        setHasSlide(false);
        setSlidePdf(false);
        rememberUrl(null);
      }
      if (folder.figmaUrl && !pendingStateRef.current?.figmaUrl) setFigmaUrl(folder.figmaUrl);
    })();
    return () => {
      cancelled = true;
      slideGen.current += 1;
      void pdfRef.current?.loadingTask.destroy().catch(() => undefined);
      pdfRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolderId, slideRev, folder?.slide?.storageKey, folder?.figmaUrl]);

  // Follow presenter state; re-hello until the first state arrives (reconnect / race).
  useEffect(() => {
    gotStateRef.current = false;
    const onMsg = (msg: { type: string } & Partial<PresentState>) => {
      if (msg.type === "closed") {
        // Controller left the room — keep last frame; stop expecting live updates until hello gets state again.
        gotStateRef.current = false;
        return;
      }
      if (msg.type !== "state") return;
      applyState(msg as PresentState);
    };
    const unsub = subscribePresentAll(onMsg);
    const hello = () => postPresent({ type: "hello", folderId: activeFolderId });
    hello();
    const retry = window.setInterval(() => {
      if (!gotStateRef.current) hello();
    }, 2000);
    return () => {
      unsub();
      window.clearInterval(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFolderId]);

  useEffect(() => {
    const onUnload = () => postPresent({ type: "closed", folderId: activeFolderId });
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      postPresent({ type: "closed", folderId: activeFolderId });
    };
  }, [activeFolderId]);

  useEffect(() => {
    if (!slidePdf || showFigma) return;
    const doc = pdfRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    const draw = async () => {
      const width = frameRef.current?.clientWidth || canvas.clientWidth || 1280;
      const pdfPage = shownPages[page - 1] ?? page;
      try {
        const rendered = await paintPage(doc, pdfPage, canvas, width);
        task = rendered;
        if (cancelled) {
          rendered.cancel();
          return;
        }
        await rendered.promise;
      } catch (err) {
        if (!cancelled && !isCancel(err)) setNote(tr("slideDrawFail"));
      }
    };

    void draw();
    let timer = 0;
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        task?.cancel();
        void draw();
      }, 120);
    });
    if (frameRef.current) ro.observe(frameRef.current);
    return () => {
      cancelled = true;
      task?.cancel();
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [page, pdfEpoch, slidePdf, shownPages, showFigma, tr]);

  useEffect(() => {
    const onFs = () => setIsFs(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Best-effort fullscreen when opened with ?fs=1 from Present (may need one click if blocked).
  useEffect(() => {
    if (!wantFullscreen) return;
    let cancelled = false;
    const tryFs = () => {
      if (cancelled || document.fullscreenElement) return;
      void document.documentElement.requestFullscreen().catch(() => undefined);
    };
    const t = window.setTimeout(tryFs, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [wantFullscreen]);

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      /* user gesture / browser policy */
    }
  }

  const anySlide = hasSlide || showFigma;

  return (
    <div className={`present-root${isFs ? " is-fs" : ""}`}>
      <div ref={frameRef} className="present-frame" data-mode={showFigma ? "figma" : slidePdf ? "pdf" : "image"}>
        {showFigma ? (
          <div className="present-slide present-figma">
            <iframe src={figmaEmbed!} title={tr("figmaLive")} allow="fullscreen" allowFullScreen />
          </div>
        ) : slidePdf ? (
          <div className="present-slide">
            <canvas ref={canvasRef} width={1920} height={1080} />
          </div>
        ) : slideUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="present-slide" src={slideUrl} alt={folder?.slideName ?? tr("figmaSlide")} />
        ) : (
          <p className="present-empty">{folder ? tr("presentNoSlide") : tr("presentNoFolder")}</p>
        )}
      </div>

      <div className="present-bar" hidden={isFs}>
        {anySlide && !showFigma && pageCount > 1 && (
          <span className="present-count">{tr("slideOf", { page, count: pageCount })}</span>
        )}
        {showFigma && <span className="present-count">{tr("presentFigmaNote")}</span>}
        {note && <span className="present-count">{note}</span>}
        <button type="button" className="room-glass-btn" onClick={() => void toggleFullscreen()}>
          {tr("presentFullscreen")}
        </button>
        <button type="button" className="room-glass-btn" onClick={() => window.close()}>
          {tr("presentExit")}
        </button>
      </div>
    </div>
  );
}
