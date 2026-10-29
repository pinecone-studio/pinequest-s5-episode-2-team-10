"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  audioFileError,
  createFolderRecord,
  deleteFolderBlob,
  detachAudio,
  folderStoreError,
  folderSnapshot,
  getFolderBlob,
  loadSpeech,
  removeFolder,
  retryFolderStore,
  saveFolderAudio,
  saveFolders,
  saveFolderSlide,
  serverFolderSnapshot,
  subscribeFolders,
  saveSpeech,
  selectAudio,
  selectedAudio,
  setFolderUser,
  slideKey,
  waitForFolderStore,
  type FolderAudio,
  type FolderMeta,
} from "@/lib/folderStore";
import { figmaEmbedUrl } from "@/lib/figmaEmbed";
import { openPdf, paintPage, pickSlides } from "@/lib/slidePdf";
import { prepareSlide, SLIDE_ACCEPT, slideKind } from "@/lib/slideFiles";
import { feedbackSteps, findQuote, loadTimings, playSpan, readAloud, saveTimings, speakText, type Clip } from "@/lib/coachVoice";
import { PieceRecorder, transcribeBlob } from "@/lib/voiceRecorder";
import { useLang } from "@/lib/i18nClient";
import type { MessageKey } from "@/lib/i18n";
import { openPresentWindow, postPresent, postPresentState, subscribePresentAll, type PresentMode } from "@/lib/presentSync";
import { useAccount } from "@/lib/session";
import { useBillingLocked } from "@/lib/billingClient";
import { notifySubscriptionRequired } from "@/lib/routeAccess";
import { api, ApiRequestError, USING_MOCK } from "@/lib/api";
import { analysisProjectKey, usesRemoteFolderStore } from "@/lib/folderStore";
import type { FeedbackBackend, Project } from "@/lib/types";
import Modal from "./Modal";
import type { Improvement, OffTopic, Strength } from "./ImprovementList";
import FeedbackResult from "./FeedbackResult";
import TakeHistory from "./TakeHistory";
import AnalysisProgress, { type AnalysisStep } from "./AnalysisProgress";
import SectionToggle, { useHidden } from "./SectionToggle";
import { PitchPointsEditor, pointsToSend, type MainPointsResult } from "./PitchPoints";
import FeedbackModelSelect, { useFeedbackModel } from "./FeedbackModelSelect";
import PoseCoach, { type CoachState } from "./PoseCoach";
import type { Side } from "@/lib/poseCoach";

// The backend's recommendation categories, as shown on a fix.
const AREA_LABELS: Record<string, MessageKey> = {
  structure: "areaStructure",
  content: "areaContent",
  delivery: "areaDelivery",
  slides: "areaSlides",
  accuracy: "areaAccuracy",
  timing: "areaTiming",
};

type Live = { stream: MediaStream; ctx: AudioContext };

const COACH_KEY = "pitchcoach:poseCoach";
type CoachPrefs = { side: Side };

const DEFAULT_COACH: CoachPrefs = { side: "right" };
const coachListeners = new Set<() => void>();
let coachPrefs: CoachPrefs | null = null; // read from storage once, then kept here

function subscribeCoach(listener: () => void) {
  coachListeners.add(listener);
  return () => coachListeners.delete(listener);
}

function coachSnapshot(): CoachPrefs {
  if (coachPrefs) return coachPrefs;
  try {
    const saved = JSON.parse(localStorage.getItem(COACH_KEY) ?? "null") as Partial<CoachPrefs> | null;
    coachPrefs = { side: saved?.side === "left" ? "left" : "right" };
  } catch {
    coachPrefs = DEFAULT_COACH;
  }
  return coachPrefs;
}

function saveCoachPrefs(next: Partial<CoachPrefs>) {
  coachPrefs = { ...coachSnapshot(), ...next };
  try {
    localStorage.setItem(COACH_KEY, JSON.stringify(coachPrefs));
  } catch {
    /* private mode: the choice lasts until reload */
  }
  coachListeners.forEach((listener) => listener());
}

function closeLive(live: Live | null) {
  live?.stream.getTracks().forEach((track) => track.stop());
  void live?.ctx.close();
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const TRANSCRIPT_PREVIEW_WORDS = 60; // longer speech text is cut; "See more" opens all of it in a dialog

/**
 * The speech text to show: all of it when open or short; otherwise the first words, or the
 * latest ones while speech is still coming in, so new words stay in view.
 */
function transcriptPreview(text: string, live: boolean): { text: string; long: boolean } {
  const words = text.split(/\s+/).filter(Boolean);
  const long = words.length > TRANSCRIPT_PREVIEW_WORDS;
  if (!long) return { text, long };
  return live
    ? { text: `… ${words.slice(-TRANSCRIPT_PREVIEW_WORDS).join(" ")}`, long }
    : { text: `${words.slice(0, TRANSCRIPT_PREVIEW_WORDS).join(" ")} …`, long };
}

function isPdf(file: Blob) {
  const named = file instanceof File ? file.name : "";
  return file.type === "application/pdf" || named.toLowerCase().endsWith(".pdf");
}

function isCancel(err: unknown) {
  return err instanceof Error && /cancel/i.test(`${err.name} ${err.message}`);
}

export default function FolderDesk() {
  const { tr } = useLang();
  const account = useAccount();
  const [ready, setReady] = useState(false);
  // The saved list, shared with the sidebar (which can rename and delete folders too).
  const folders = useSyncExternalStore(subscribeFolders, folderSnapshot, serverFolderSnapshot);
  // The open folder lives in the URL (?folder=<id>), so the sidebar can link to it and Back works.
  const router = useRouter();
  const pathname = usePathname();
  const openId = useSearchParams().get("folder");
  function setOpenId(id: string | null) {
    router.push(id ? `${pathname}?folder=${encodeURIComponent(id)}` : pathname);
  }
  const [naming, setNaming] = useState(false);
  // Trial or plan over: existing pitches stay readable, new ones open the renew dialog instead.
  const locked = useBillingLocked();
  function startNewPitch() {
    if (locked) notifySubscriptionRequired();
    else setNaming(true);
  }
  // The pitch whose delete confirmation is open, from the × on its card.
  const [deleting, setDeleting] = useState<FolderMeta | null>(null);
  const [draft, setDraft] = useState("");
  const [slideFile, setSlideFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [newSlideError, setNewSlideError] = useState<string | null>(null);
  // A new folder's slides come from an uploaded file or a Figma link.
  const [source, setSource] = useState<"file" | "figma">("file");
  const [newFigma, setNewFigma] = useState("");
  const figmaLink = newFigma.trim();
  const figmaBad = source === "figma" && !!figmaLink && !figmaEmbedUrl(figmaLink);
  const hasSource = source === "file" ? !!slideFile && !newSlideError : !!figmaLink && !figmaBad;

  async function pickNewSlide(file: File | null) {
    setNewSlideError(null);
    setSlideFile(file);
    if (file && !(await slideKind(file))) setNewSlideError(tr("slideWrongType"));
  }

  useEffect(() => {
    let cancelled = false;
    setFolderUser(account?.id ?? null, account?.email === "demo@pitchcoach.local");
    void waitForFolderStore().finally(() => {
      if (!cancelled) setReady(true);
    });
    return () => { cancelled = true; };
  }, [account?.id, account?.email]);

  function persist(next: FolderMeta[]) {
    saveFolders(next);
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name || !hasSource) return;
    setCreating(true);
    setNewSlideError(null);
    let folder: FolderMeta;
    try {
      folder = await createFolderRecord({
      name,
      slideName: null,
      audioName: null,
      figmaUrl: source === "figma" ? figmaLink : null,
      });
    } catch (err) {
      setNewSlideError(err instanceof Error ? err.message : tr("authFailed"));
      setCreating(false);
      return;
    }
    if (source === "file" && slideFile) {
      let slide: File;
      try {
        slide = await prepareSlide(slideFile); // PowerPoint decks become PDF here
      } catch (err) {
        setNewSlideError(err instanceof Error ? err.message : tr("deckConvertFailed"));
        setCreating(false);
        return;
      }
      try {
        folder = await saveFolderSlide(folder, slide);
      } catch (err) {
        setNewSlideError(err instanceof Error ? err.message : tr("slideWrongType"));
        setCreating(false);
        return;
      }
    }
    persist([folder, ...folders]);
    setDraft("");
    setSlideFile(null);
    setNewFigma("");
    setNaming(false);
    setOpenId(folder.id);
    setCreating(false);
  }

  const open = folders.find((f) => f.id === openId) ?? null;

  if (!ready) {
    return (
      <main className="desk folder-board folder-list" aria-busy="true">
        <div className="desk-col">
          <div className="desk-title">
            <div>
              <h1>{tr("folders")}</h1>
              <p className="desk-sub" role="status">{tr("foldersLoading")}</p>
            </div>
          </div>
          <ul className="folder-grid folder-skeleton-grid" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="folder-skeleton-card">
                <span className="folder-skeleton-cover" />
                <span className="folder-skeleton-info">
                  <span className="folder-skeleton-line is-title" />
                  <span className="folder-skeleton-line is-meta" />
                </span>
              </li>
            ))}
          </ul>
        </div>
      </main>
    );
  }

  const syncError = folderStoreError();
  if (syncError) {
    return (
      <main className="desk folder-board">
        <div className="desk-col">
          <div className="ui-card admin-error" role="alert">
            <span>{syncError}</span>
            <button type="button" className="ui-btn" onClick={() => {
              setReady(false);
              void retryFolderStore().finally(() => setReady(true));
            }}>{tr("folderSyncRetry")}</button>
          </div>
        </div>
      </main>
    );
  }

  if (!open) {
    return (
      <div className="desk folder-board folder-list">
        <div className="desk-col">
          <div className="desk-title">
            <div>
              <h1>
                {tr("folders")}
                {folders.length > 0 && <span className="folder-list-count">{folders.length}</span>}
              </h1>
              <p className="desk-sub">{tr("foldersLead")}</p>
            </div>
          </div>

          {naming && (
            <Modal title={tr("addFolder")} onClose={() => setNaming(false)}>
              <form onSubmit={createFolder} className="desk-panel">
                <label>
                  <span>{tr("folderName")}</span>
                  <input
                    type="text"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="figma tdd"
                  />
                </label>
                <div className="desk-source-head">
                  <span>{tr("slide")}</span>
                  <div className="desk-source" role="group" aria-label={tr("slide")}>
                    <button type="button" aria-pressed={source === "file"} onClick={() => setSource("file")}>
                      {tr("sourceFile")}
                    </button>
                    <button type="button" aria-pressed={source === "figma"} onClick={() => setSource("figma")}>
                      {tr("sourceLink")}
                    </button>
                  </div>
                </div>
                {source === "file" ? (
                  <>
                    <label>
                      <span className="desk-file">
                        <span>{slideFile ? slideFile.name : tr("uploadSlideHint")}</span>
                        <span>{slideFile ? tr("change") : tr("upload")}</span>
                        <input
                          type="file"
                          accept={SLIDE_ACCEPT}
                          className="sr-only"
                          onChange={(e) => void pickNewSlide(e.target.files?.[0] ?? null)}
                        />
                      </span>
                    </label>
                    {newSlideError && <p className="desk-note">{newSlideError}</p>}
                  </>
                ) : (
                  <>
                    <label>
                      <input
                        type="url"
                        autoFocus
                        value={newFigma}
                        onChange={(e) => setNewFigma(e.target.value)}
                        placeholder="https://www.figma.com/slides/…"
                        aria-label={tr("figmaLinkLabel")}
                        spellCheck={false}
                      />
                    </label>
                    <p className={figmaBad ? "desk-note" : "desk-hint"}>{figmaBad ? tr("figmaBad") : tr("figmaShareHint")}</p>
                  </>
                )}
                <div className="app-modal-actions">
                  <button
                    type="submit"
                    className="desk-primary"
                    disabled={!draft.trim() || !hasSource || creating}
                  >
                    {creating ? tr("convertingSlide") : tr("createOpen")}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {folders.length === 0 ? (
            <div className="folder-empty">
              <span className="folder-ring" aria-hidden />
              <h2>{tr("foldersNone")}</h2>
              <p>{tr("foldersEmpty")}</p>
              <button type="button" className="desk-primary" onClick={startNewPitch}>
                {locked ? <LockGlyph /> : <PlusGlyph />}
                {tr("addFolder")}
              </button>
            </div>
          ) : (
            <ul className="folder-grid">
              <li>
                <button type="button" className="folder-card folder-card-add" onClick={startNewPitch}>
                  <span className="folder-card-add-icon">{locked ? <LockGlyph size={18} /> : <PlusGlyph size={18} />}</span>
                  {tr("addFolder")}
                </button>
              </li>
              {folders.map((folder) => (
                <FolderCard
                  key={folder.id}
                  folder={folder}
                  onOpen={() => setOpenId(folder.id)}
                  onDelete={() => setDeleting(folder)}
                />
              ))}
            </ul>
          )}

          {deleting && (
            <Modal title={tr("deleteFolderTitle", { name: deleting.name })} onClose={() => setDeleting(null)}>
              <p className="folder-delete-text">{tr("deleteFolderText")}</p>
              <div className="app-modal-actions folder-delete-actions">
                <button type="button" className="ui-btn" onClick={() => setDeleting(null)}>
                  {tr("cancel")}
                </button>
                <button
                  type="button"
                  className="folder-delete-btn is-confirm"
                  autoFocus
                  onClick={() => {
                    const folder = deleting;
                    setDeleting(null);
                    void removeFolder(folder);
                  }}
                >
                  {tr("deleteFolder")}
                </button>
              </div>
            </Modal>
          )}
        </div>
      </div>
    );
  }

  async function deleteFolder(folder: FolderMeta) {
    setOpenId(null);
    await removeFolder(folder);
  }

  return (
    <FolderRoom
      folder={open}
      onBack={() => setOpenId(null)}
      onChange={(next) => persist(folders.map((f) => (f.id === next.id ? next : f)))}
      onDelete={() => void deleteFolder(open)}
    />
  );
}

function FolderRoom({
  folder,
  onBack,
  onChange,
  onDelete,
}: {
  folder: FolderMeta;
  onBack: () => void;
  onChange: (folder: FolderMeta) => void;
  /** Deletes the whole folder (after the user confirms). */
  onDelete: () => void;
}) {
  const { tr, lang } = useLang();
  const account = useAccount();
  // Trial or plan over: recording, new audio, and analysis open the renew dialog instead.
  const locked = useBillingLocked();
  /** The model's id ("ollama") as people know it ("Gemma"). */
  const modelLabel = (id: string) =>
    ({ ollama: "Gemma", "ollama-think": tr("modelGemmaCareful"), "gemma4-base": "Gemma", "gemma4-ft": "Gemma", claude: "Claude", rules: tr("rulesName") })[id] ?? id;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const recRef = useRef<PieceRecorder | null>(null);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const takeBaseRef = useRef("");
  const aliveRef = useRef(true);
  const playingRef = useRef(false);
  const sttGen = useRef(0);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const slideGen = useRef(0);
  const slideUrlRef = useRef<string | null>(null);
  const liveRef = useRef<Live | null>(null);
  const [model, setModel] = useFeedbackModel();
  const [pending, setPending] = useState(0);
  const [fileBusy, setFileBusy] = useState(false);

  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [slidePdf, setSlidePdf] = useState(false);
  const [hasSlide, setHasSlide] = useState(false);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [shownPages, setShownPages] = useState<number[]>([]); // PDF page numbers on screen; empty = all
  const [hiddenPages, setHiddenPages] = useState(0); // animation steps and empty pages left out
  const [transitions, setTransitions] = useState<number[]>([]); // shown slides with hardly any text
  // A Figma link plays the deck live (with its animations); the PDF still feeds the analysis.
  const [figmaEditing, setFigmaEditing] = useState(false);
  const [figmaDraft, setFigmaDraft] = useState("");
  const [figmaError, setFigmaError] = useState(false);
  const [preferPdf, setPreferPdf] = useState(false);
  const figmaEmbed = folder.figmaUrl ? figmaEmbedUrl(folder.figmaUrl) : null;
  const showFigma = !!figmaEmbed && !(preferPdf && hasSlide);
  const anySlide = hasSlide || !!figmaEmbed;
  const [pdfEpoch, setPdfEpoch] = useState(0);
  const [listening, setListening] = useState(false);
  const [reading, setReading] = useState<string | null>(null); // the result item being read aloud
  const [finalText, setFinalText] = useState("");
  const textRef = useRef("");
  const [sttNote, setSttNote] = useState<string | null>(null);
  const [slideNote, setSlideNote] = useState<"pdfOpenFail" | "slideDrawFail" | null>(null);
  const [slideMsg, setSlideMsg] = useState<string | null>(null); // converting, or why a picked file was refused
  const [full, setFull] = useState(false);
  /** Audience (TV) window — MacBook stays on this page with all tools. */
  const presentWinRef = useRef<Window | null>(null);
  const [presentNote, setPresentNote] = useState<string | null>(null);
  const [slideRev, setSlideRev] = useState(0);
  // The camera coach: counts pointing at the slide and turns slides with a hand swipe.
  const coach = useSyncExternalStore(subscribeCoach, coachSnapshot, () => DEFAULT_COACH);
  const [cameraOn, setCameraOn] = useState(false);
  const [coachState, setCoachState] = useState<CoachState | null>(null);
  const [transcriptOpen, setTranscriptOpen] = useState(false); // the full speech text in a dialog
  const transcriptRef = useRef<HTMLParagraphElement | null>(null);
  const previewRef = useRef<HTMLParagraphElement | null>(null);
  const [previewCut, setPreviewCut] = useState(false); // the preview is taller than the speech card
  const [probing, setProbing] = useState(false);
  const [audiosHidden, toggleAudios] = useHidden("pitch-audio");
  const [takesVersion, setTakesVersion] = useState(0); // bumped after each analysis, so the takes card reloads
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [resultOpen, setResultOpen] = useState(false); // the analysis dialog
  const resultShownRef = useRef(false); // opened once per analysis, so closing it while it streams sticks
  const [probeResult, setProbeResult] = useState<{
    summary: string;
    strengths: Strength[];
    improvements: Improvement[];
    offTopic: OffTopic[];
    model: string;
    mainPoints: MainPointsResult | null;
    pointSlides: (number | null)[]; // the slide of each point sent, in the reply's order
    received: { text: boolean; audio: string | null; slide: string | null } | null;
    writing: boolean; // true while the model is still writing (shown as it arrives, not checked yet)
    fallbacks?: { part: "speech_to_text" | "feedback"; used: string }[]; // what stood in for the GPU PC
  } | null>(null);
  // Where a running analysis is, for the step list under the Analyze button.
  const [analysisStep, setAnalysisStep] = useState<AnalysisStep | null>(null);
  // Set when an analysis finishes, so the coach voice starts reading the result once it's on screen.
  const autoReadRef = useRef(false);

  function rememberUrl(next: string | null) {
    if (slideUrlRef.current) URL.revokeObjectURL(slideUrlRef.current);
    slideUrlRef.current = next;
    setSlideUrl(next);
  }

  async function loadSlide(file: Blob) {
    const gen = ++slideGen.current;
    const pdf = isPdf(file);
    setHasSlide(true);
    if (!pdf) {
      await pdfRef.current?.loadingTask.destroy().catch(() => undefined);
      if (slideGen.current !== gen) return;
      pdfRef.current = null;
      setSlidePdf(false);
      setPageCount(0);
      setShownPages([]);
      setHiddenPages(0);
      setTransitions([]);
      setPage(1);
      rememberUrl(URL.createObjectURL(file));
      setSlideNote(null);
      setSlideRev((n) => n + 1);
      return;
    }
    setSlidePdf(true);
    setSlideNote(null);
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
      setPageCount(doc.numPages);
      setShownPages([]);
      setHiddenPages(0);
      setTransitions([]);
      setPage(1);
      setPdfEpoch((n) => n + 1);
      const picked = await pickSlides(doc).catch(() => null);
      if (picked && slideGen.current === gen) setTransitions(picked.transitions);
      if (picked && slideGen.current === gen && picked.hidden > 0) {
        setShownPages(picked.pages);
        setHiddenPages(picked.hidden);
        setPageCount(picked.pages.length);
        setPage(1);
      }
      if (slideGen.current === gen) setSlideRev((n) => n + 1);
    } catch {
      if (slideGen.current !== gen) return;
      setSlideNote("pdfOpenFail");
    }
  }

  useEffect(() => {
    let cancelled = false;
    aliveRef.current = true;

    (async () => {
      const slide = await getFolderBlob(folder.slide?.storageKey ?? slideKey(folder.id));
      if (cancelled) return;
      if (slide) await loadSlide(slide);
      else {
        setHasSlide(false);
        setSlidePdf(false);
        setPageCount(0);
        setShownPages([]);
        setHiddenPages(0);
        setTransitions([]);
        rememberUrl(null);
        setSlideNote(null);
      }
    })();

    return () => {
      cancelled = true;
      slideGen.current += 1;
      void pdfRef.current?.loadingTask.destroy().catch(() => undefined);
      pdfRef.current = null;
      if (slideUrlRef.current) URL.revokeObjectURL(slideUrlRef.current);
      slideUrlRef.current = null;
      aliveRef.current = false;
      sttGen.current += 1;
      playingRef.current = false;
      void recRef.current?.stop();
      recRef.current = null;
      closeLive(liveRef.current);
      liveRef.current = null;
    };
    // loadSlide closes over stable setters; reload only when the folder changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id]);

  useEffect(() => {
    const saved = folder.script ?? loadSpeech(folder.id);
    textRef.current = saved ? `${saved} ` : "";
    setFinalText(textRef.current);
  }, [folder.id, folder.script]);

  useEffect(() => {
    if (!slidePdf || showFigma) return;
    const doc = pdfRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    const draw = async () => {
      const width = frameRef.current?.clientWidth || canvas.clientWidth || 960;
      try {
        const rendered = await paintPage(doc, shownPages[page - 1] ?? page, canvas, width);
        task = rendered;
        if (cancelled) {
          rendered.cancel();
          return;
        }
        await rendered.promise;
      } catch (err) {
        if (!cancelled && !isCancel(err)) setSlideNote("slideDrawFail");
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
  }, [page, pdfEpoch, slidePdf, full, shownPages, showFigma]);

  function swipeSlide(swipe: "next" | "prev") {
    if (showFigma || pageCount < 2) return; // a Figma deck turns its own pages
    setPage((current) => (swipe === "next" ? Math.min(pageCount, current + 1) : Math.max(1, current - 1)));
  }

  function presentMode(): PresentMode {
    if (showFigma) return "figma";
    if (slidePdf) return "pdf";
    return "image";
  }

  function broadcastPresent() {
    if (!anySlide) return;
    postPresentState({
      folderId: folder.id,
      page,
      pageCount,
      shownPages,
      mode: presentMode(),
      slideRev,
      figmaUrl: folder.figmaUrl ?? null,
    });
  }

  /**
   * Opens or reuses a slide-only window for the TV/projector. MacBook stays here.
   * Window Management API places on an external display when allowed; else manual drag.
   */
  /** Slide-only TV window. Needs Extend (not Mirror). MacBook stays on FolderDesk. */
  async function openPresent() {
    setPresentNote(null);
    if (!anySlide) return;
    const existing = presentWinRef.current && !presentWinRef.current.closed ? presentWinRef.current : null;
    const { win, onExternal, reused, layout } = await openPresentWindow(folder.id, existing);
    if (!win) {
      setPresentNote(tr("presentBlocked"));
      return;
    }
    presentWinRef.current = win;
    const noteKey =
      layout === "single"
        ? "presentMirrorHint"
        : reused
          ? "presentTvReuseHint"
          : onExternal
            ? "presentTvAutoHint"
            : "presentTvHint";
    setPresentNote(tr(noteKey));
    broadcastPresent();
    window.setTimeout(() => broadcastPresent(), 250);
  }

  useEffect(() => {
    if (!anySlide) return;
    broadcastPresent();
    return subscribePresentAll((msg) => {
      if (msg.type === "hello") broadcastPresent();
      if (msg.type === "closed") presentWinRef.current = null;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id, page, pageCount, shownPages, showFigma, slidePdf, anySlide, folder.figmaUrl, slideRev]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (presentWinRef.current?.closed) presentWinRef.current = null;
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  // Leaving the pitch room entirely (back to folder list) — end the present session.
  // Folder switches keep the audience window and send a new state via broadcastPresent.
  const presentFolderIdRef = useRef(folder.id);
  presentFolderIdRef.current = folder.id;
  useEffect(() => {
    return () => {
      postPresent({ type: "closed", folderId: presentFolderIdRef.current });
      presentWinRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [full]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (figmaEditing) {
          setFigmaEditing(false);
          setFigmaError(false);
          return;
        }
        setFull(false);
        return;
      }
      if (pageCount < 2) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      setPage((current) => {
        if (e.key === "ArrowRight") return Math.min(pageCount, current + 1);
        return Math.max(1, current - 1);
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageCount, figmaEditing]);

  function writeSpeech(next: string) {
    const cleaned = next.replace(/\s+/g, " ").trim();
    textRef.current = cleaned ? `${cleaned} ` : "";
    saveSpeech(folder.id, cleaned);
    setFinalText(textRef.current);
  }

  /** Pieces are transcribed one after another so the text stays in speaking order. */
  function queueTranscript(blob: Blob, name: string) {
    setPending((n) => n + 1);
    queueRef.current = queueRef.current.then(async () => {
      try {
        const reply = await transcribeBlob(blob, name);
        if (aliveRef.current && reply.text.trim()) writeSpeech(`${textRef.current} ${reply.text}`);
      } catch (err) {
        if (aliveRef.current) setSttNote(err instanceof Error ? err.message : tr("sttFail"));
      } finally {
        if (aliveRef.current) setPending((n) => n - 1);
      }
    });
  }

  /** Saves the whole take as the folder's audio, then replaces the live text with a full transcription. */
  async function finishTake(take: Blob, extension: string, base: string, gen: number) {
    if (take.size < 2_000) return; // shorter than a moment of sound
    const name = `${tr("recordingName")}.${extension}`;
    const stored = await storeAudio(take, name, take.type || "audio/webm");
    if (!stored || !aliveRef.current) return;

    // The live pieces were cut short; the whole take reads better with full context.
    setFileBusy(true);
    try {
      await queueRef.current;
      const reply = await transcribeBlob(take, name);
      saveTimings(stored, reply.words);
      if (aliveRef.current && sttGen.current === gen && reply.text.trim()) writeSpeech(`${base} ${reply.text}`);
    } catch {
      /* keep the live text */
    } finally {
      if (aliveRef.current) setFileBusy(false);
    }
  }

  function stopStt() {
    sttGen.current += 1;
    playingRef.current = false;
    setListening(false);
    const rec = recRef.current;
    const live = liveRef.current;
    recRef.current = null;
    liveRef.current = null;
    if (!rec) {
      closeLive(live);
      return;
    }
    const gen = sttGen.current;
    const base = takeBaseRef.current;
    void rec.stop().then((take) => {
      closeLive(live);
      if (take && aliveRef.current) void finishTake(take, rec.extension, base, gen);
    });
  }

  async function beginStt() {
    stopStt();
    const mine = sttGen.current;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setSttNote(tr("browserNoRecord"));
      return;
    }
    playingRef.current = true;
    setListening(true);
    setSttNote(null);
    takeBaseRef.current = textRef.current;
    const ctx = new AudioContext();
    void ctx.resume();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // Call-style processing (noise suppression, auto gain) distorts speech for the speech model.
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch {
      void ctx.close();
      if (sttGen.current === mine) {
        playingRef.current = false;
        setListening(false);
        setSttNote(tr("micBlocked"));
      }
      return;
    }
    if (sttGen.current !== mine) {
      closeLive({ stream, ctx });
      return;
    }
    const node = ctx.createAnalyser();
    node.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(node);
    liveRef.current = { stream, ctx };
    const rec = new PieceRecorder(stream, node, queueTranscript);
    try {
      rec.start();
      recRef.current = rec;
    } catch {
      stopStt();
      setSttNote(tr("recordStartFail"));
    }
  }

  /** Re-transcribes the whole saved audio file and replaces the text with it. */
  async function transcribeAudioFile() {
    const saved = selectedAudio(folder);
    const audio = saved ? await getFolderBlob(saved.storageKey) : null;
    if (!audio) return;
    setFileBusy(true);
    setSttNote(null);
    try {
      const reply = await transcribeBlob(audio, folder.audioName ?? "audio.webm");
      if (saved) saveTimings(saved.storageKey, reply.words);
      if (!aliveRef.current) return;
      if (reply.text.trim()) writeSpeech(reply.text);
      else setSttNote(tr("noSpeechInAudio"));
    } catch (err) {
      if (aliveRef.current) setSttNote(err instanceof Error ? err.message : tr("sttFail"));
    } finally {
      if (aliveRef.current) setFileBusy(false);
    }
  }

  async function chooseSlide(picked: File | undefined) {
    if (!picked) return;
    setSlideMsg(tr("convertingSlide"));
    let file: File;
    try {
      file = await prepareSlide(picked); // PowerPoint decks become PDF here
    } catch (err) {
      setSlideMsg(err instanceof Error ? err.message : tr("deckConvertFailed"));
      return;
    }
    setSlideMsg(null);
    try {
      const next = await saveFolderSlide(folder, file);
      if (!aliveRef.current) return;
      onChange(next);
      await loadSlide(file);
    } catch (err) {
      setSlideMsg(err instanceof Error ? err.message : tr("slideWrongType"));
    }
  }

  function readDuration(file: Blob): Promise<number | null> {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const audio = document.createElement("audio");
      let settled = false;
      const done = (value: number | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        URL.revokeObjectURL(url);
        resolve(value);
      };
      const timer = window.setTimeout(() => done(null), 2000);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? Math.round(audio.duration * 100) / 100 : null);
      audio.onerror = () => done(null);
      audio.src = url;
    });
  }

  /** Adds one audio file to this folder's slide. The newest take is the one that plays. */
  async function storeAudio(file: Blob, name: string, type: string): Promise<string | null> {
    const problem = audioFileError({ name, type, size: file.size });
    if (problem) {
      setSttNote(tr(problem === "size" ? "audioTooBig" : "audioWrongType"));
      return null;
    }
    try {
      const next = await saveFolderAudio(folder, file, name, type, await readDuration(file));
      if (!aliveRef.current) return null;
      const record = selectedAudio(next);
      if (!record) return null;
      onChange(next);
      setSttNote(null);
      return record.storageKey;
    } catch (err) {
      if (aliveRef.current) setSttNote(err instanceof Error ? err.message : tr("sttFail"));
      return null;
    }
  }

  async function chooseAudio(file: File | undefined) {
    if (!file) return;
    if (locked) return notifySubscriptionRequired();
    await storeAudio(file, file.name, file.type);
  }

  function pickSaved(id: string) {
    onChange(selectAudio(folder, id));
  }

  async function dropAudio(id: string) {
    const { folder: next, storageKey } = detachAudio(folder, id);
    if (storageKey) await deleteFolderBlob(storageKey);
    if (!aliveRef.current) return;
    onChange(next);
  }

  function toggleSpeak() {
    if (playingRef.current) stopStt();
    else if (locked) notifySubscriptionRequired();
    else void beginStt();
  }

  function saveFigma(e: React.FormEvent) {
    e.preventDefault();
    const value = figmaDraft.trim();
    if (!value) return removeFigma();
    if (!figmaEmbedUrl(value)) return setFigmaError(true);
    onChange({ ...folder, figmaUrl: value });
    setFigmaEditing(false);
    setFigmaError(false);
    setPreferPdf(false);
  }

  function removeFigma() {
    onChange({ ...folder, figmaUrl: null });
    setFigmaEditing(false);
    setFigmaError(false);
  }

  /** Opens the analysis dialog the first time this analysis has something to show. */
  function showResultOnce() {
    if (resultShownRef.current) return;
    resultShownRef.current = true;
    setResultOpen(true);
  }

  /** Where the speaker said `quote` in the selected recording, or null when its timing isn't known. */
  function ownClip(quote: string): (() => Promise<Clip | null>) | null {
    const saved = selectedAudio(folder);
    const span = saved ? findQuote(quote, loadTimings(saved.storageKey)) : null;
    if (!saved || !span) return null;
    return async () => {
      const recording = await getFolderBlob(saved.storageKey);
      return recording ? { recording, ...span } : null;
    };
  }

  function hearOwn(quote: string): (() => Promise<void>) | null {
    const clip = ownClip(quote);
    if (!clip) return null;
    return async () => {
      const c = await clip();
      if (c) await playSpan(c.recording, c.start, c.end);
    };
  }

  /** The coach voice reads the whole analysis, with the speaker's own words where they fit. */
  function readResult(): Promise<void> {
    if (!probeResult) return Promise.resolve();
    return readAloud(feedbackSteps(probeResult, ownClip), setReading);
  }

  // A finished analysis is read aloud straight away (the Analyze click allows sound to play).
  useEffect(() => {
    if (!autoReadRef.current || !probeResult || probeResult.writing) return;
    autoReadRef.current = false;
    readResult().catch(() => {}); // no voice available (not set up, daily limit): the text is on screen
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once per finished analysis, not when readResult changes
  }, [probeResult]);

  async function sendToModel() {
    if (locked) return notifySubscriptionRequired();
    const saved = selectedAudio(folder);
    if (!saved) {
      setProbeNote(lang === "mn" ? "Эхлээд аудио бичлэгээ оруулна уу." : "Upload or record audio before analyzing.");
      return;
    }
    if (!account) {
      setProbeNote(lang === "mn" ? "Шинжилгээ хадгалахын тулд нэвтэрнэ үү." : "Sign in to save your analysis.");
      return;
    }
    if (USING_MOCK) {
      setProbeNote(lang === "mn" ? "Backend тохируулагдаагүй байна. Backend URL-ээ тохируулна уу." : "The backend is not configured. Set the backend URL and try again.");
      return;
    }
    setProbing(true);
    setAnalysisStep("upload");
    setProbeNote(null);
    setProbeResult(null);
    setResultOpen(false);
    resultShownRef.current = false;
    try {
      const [audio, slide] = await Promise.all([
        getFolderBlob(saved.storageKey),
        getFolderBlob(folder.slide?.storageKey ?? slideKey(folder.id)),
      ]);
      if (!audio) throw new Error(lang === "mn" ? "Аудио файлыг уншиж чадсангүй. Дахин сонгоно уу." : "Could not read the audio file. Select it again.");

      let project: Project;
      if (usesRemoteFolderStore()) {
        project = await api.getProject(folder.id);
      } else {
        const mapKey = analysisProjectKey(account.id, folder.id);
        const mappedId = localStorage.getItem(mapKey);
        try {
          project = mappedId ? await api.getProject(mappedId) : await api.createProject({ name: folder.name });
        } catch (err) {
          if (!mappedId || !(err instanceof ApiRequestError) || err.status !== 404) throw err;
          project = await api.createProject({ name: folder.name });
        }
        localStorage.setItem(mapKey, project.id);
      }
      project = await api.updateProject(project.id, {
        name: folder.name,
        idea: folder.idea ?? "",
        key_points: folder.keyPoints ?? [],
        point_slides: folder.pointSlides ?? [],
        figma_url: folder.figmaUrl ?? null,
      });
      const attempt = await api.createAttempt(project.id, false);
      if (slide && folder.slide) {
        await api.uploadSlides(attempt.id, new File([slide], folder.slide.filename, { type: slide.type || folder.slide.fileType }));
      }
      await api.uploadAudio(attempt.id, audio, saved.filename);
      const backend: FeedbackBackend = model === "claude" ? "claude" : model === "rules" ? "rules" : "gemma4-base";
      await api.analyze(attempt.id, backend);
      showResultOnce();
      const deadline = Date.now() + 10 * 60_000;
      let status = await api.status(attempt.id);
      while (status.status === "processing" || status.status === "created" || status.status === "uploaded") {
        // No stage yet (still in line): keep showing the upload step.
        setAnalysisStep(status.stage ?? "upload");
        if (Date.now() > deadline) throw new Error(lang === "mn" ? "Шинжилгээ удаж байна. Дараа нь үр дүнгээ дахин нээнэ үү." : "Analysis is taking longer than expected. Check the result again shortly.");
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        status = await api.status(attempt.id);
      }
      if (status.status !== "completed") throw new Error(status.error || (lang === "mn" ? "Backend шинжилгээ хийж чадсангүй." : "The backend could not analyze this recording."));
      const report = await api.report(attempt.id);
      const points = report.feedback.main_points?.points ?? [];
      // The backend says when each problem happens (snapped to a sentence start); show that sentence
      // as "you said", so the speaker sees and can hear their own words.
      const sentences = report.transcript.sentences ?? [];
      const sentenceAt = (t: number | null) =>
        t == null ? "" : (sentences.find((s) => t >= s.start - 0.05 && t < s.end + 0.05)?.text ?? "");
      setProbeResult({
        summary: report.feedback.summary,
        strengths: report.feedback.strengths.map((text) => ({ text, quote: "" })),
        improvements: report.feedback.recommendations.map((item) => ({
          source: "model",
          // `problem` says what's wrong; `area` is only its category, shown as a tag.
          title: item.problem || tr(AREA_LABELS[item.area] ?? "areaContent"),
          category: tr(AREA_LABELS[item.area] ?? "areaContent"),
          why: item.why,
          action: item.action,
          example: item.example_sentence,
          quote: sentenceAt(item.start_s),
        })),
        offTopic: (report.feedback.main_points?.off_topic ?? []).map((item) => ({ sentenceId: item.sentence_id, text: item.text, reason: item.reason })),
        model: report.backend,
        mainPoints: report.feedback.main_points ? {
          method: report.feedback.main_points.method,
          points: points.map(({ point, text, status, verified, evidence, note }) => ({ point, text, status, verified, evidence, note })),
          coverage: report.feedback.main_points.coverage,
          ideaComment: report.feedback.main_points.idea_comment,
        } : null,
        pointSlides: pointsToSend(folder.keyPoints, folder.pointSlides).slides,
        received: { text: !!report.transcript.text, audio: saved.filename, slide: slide && folder.slide ? folder.slide.filename : null },
        writing: false,
        fallbacks: report.fallbacks ?? [],
      });
      autoReadRef.current = true;
      showResultOnce();
      setTakesVersion((v) => v + 1);
    } catch (err) {
      setProbeResult(null);
      setProbeNote(err instanceof Error && err.message ? err.message : tr("sendFail"));
    } finally {
      setProbing(false);
      setAnalysisStep(null);
    }
  }

  const spoken = finalText.trim();
  const transcript = transcriptPreview(spoken, listening || pending > 0);

  // The speech card has the slide's height: the preview shows what fits (newest words while speech
  // comes in), and "See more" appears whenever some of it is cut off.
  useEffect(() => {
    const box = previewRef.current;
    if (!box) return;
    const measure = () => {
      if (listening || pending > 0) box.scrollTop = box.scrollHeight;
      setPreviewCut(box.scrollHeight > box.clientHeight + 1);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    measure();
    return () => observer.disconnect();
  }, [spoken, listening, pending]);

  // The dialog scrolls; while speech comes in, keep the newest words in view.
  useEffect(() => {
    const box = transcriptRef.current;
    if (box && transcriptOpen && (listening || pending > 0)) box.scrollTop = box.scrollHeight;
  }, [spoken, transcriptOpen, listening, pending]);
  function cameraButton() {
    return (
      <button type="button" className="room-glass-btn" aria-pressed={cameraOn} onClick={() => setCameraOn((on) => !on)}>
        <CameraGlyph />
        {cameraOn ? tr("cameraClose") : tr("cameraOpen")}
      </button>
    );
  }
  function speakButton() {
    return (
      <button type="button" className={listening ? "room-speak-btn is-recording" : "room-speak-btn"} onClick={toggleSpeak}>
        {listening ? <span className="desk-rec" aria-hidden /> : locked ? <LockGlyph /> : <MicGlyph />}
        {listening ? tr("stop") : tr("speak")}
      </button>
    );
  }
  function pageButtons() {
    if (pageCount < 2) return null;
    return (
      <div className="room-pager" role="group" aria-label={tr("slideOf", { page, count: pageCount })}>
        <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
          <ChevronGlyph dir="left" />
          {tr("prev")}
        </button>
        <span className="desk-count">
          {page} / {pageCount}
        </span>
        <button type="button" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>
          {tr("next")}
          <ChevronGlyph dir="right" />
        </button>
      </div>
    );
  }

  const speechBusy = listening || pending > 0 || fileBusy;
  const analyzing = probing || !!probeResult?.writing;
  const steps: { title: MessageKey; hint: MessageKey; done: boolean; active: boolean }[] = [
    { title: "landingStep1Title", hint: "roomStep1Hint", done: anySlide, active: false },
    { title: "landingStep2Title", hint: "roomStep2Hint", done: !!spoken && !speechBusy, active: speechBusy },
    { title: "landingStep3Title", hint: "roomStep3Hint", done: !!probeResult && !analyzing, active: analyzing },
  ];
  const currentStep = steps.findIndex((step) => !step.done);
  const speechStatus = listening
    ? { tone: "is-live", text: tr("listening") }
    : pending > 0 || fileBusy
      ? { tone: "is-busy", text: tr("transcribing") }
      : spoken
        ? { tone: "is-saved", text: tr("speechSaved") }
        : null;

  return (
    <div className="desk folder-board folder-room">
      <div className="desk-col">
        <header className="room-toolbar">
          <div className="room-heading">
            <button type="button" className="room-back" onClick={onBack}>
              <ChevronGlyph dir="left" />
              {tr("folders")}
            </button>
            <h1>{folder.name}</h1>
            <p className="desk-sub">
              {showFigma
                ? tr("figmaLive")
                : pageCount > 1
                  ? tr("slideOf", { page, count: pageCount })
                  : tr("speakHint")}
              {!showFigma && hiddenPages > 0 && ` · ${tr("slidesHidden", { count: hiddenPages })}`}
            </p>
          </div>
          <div className="room-actions" hidden={full && anySlide}>
            {figmaEditing && !full && (
              <button
                type="button"
                className="room-popover-scrim"
                aria-label={tr("close")}
                onClick={() => (setFigmaEditing(false), setFigmaError(false))}
              />
            )}
            <div className="desk-link-bar">
              <button
                type="button"
                className="room-glass-btn"
                aria-expanded={figmaEditing}
                onClick={() => {
                  if (figmaEditing) {
                    setFigmaEditing(false);
                    setFigmaError(false);
                    return;
                  }
                  setFigmaDraft(folder.figmaUrl ?? "");
                  setFigmaEditing(true);
                }}
              >
                <LinkGlyph />
                {tr("figmaAdd")}
              </button>
              {figmaEditing && (
                <form onSubmit={saveFigma} className="desk-link-popover" role="dialog" aria-label={tr("figmaLinkLabel")}>
                  <input
                    type="url"
                    value={figmaDraft}
                    onChange={(e) => setFigmaDraft(e.target.value)}
                    placeholder="https://www.figma.com/slides/…"
                    aria-label={tr("figmaLinkLabel")}
                    autoFocus
                  />
                  {figmaError && <p className="desk-note">{tr("figmaBad")}</p>}
                  <div className="desk-link-actions">
                    <button type="button" className="desk-ghost" onClick={() => (setFigmaEditing(false), setFigmaError(false))}>
                      {tr("figmaCancel")}
                    </button>
                    <button type="submit" className="desk-primary">
                      {tr("figmaSave")}
                    </button>
                  </div>
                </form>
              )}
            </div>
            <FeedbackModelSelect value={model} onChange={setModel} />
            <button
              type="button"
              className="room-icon-btn is-danger"
              aria-label={tr("deleteFolder")}
              title={tr("deleteFolder")}
              onClick={() => setConfirmDelete(true)}
            >
              <TrashGlyph />
            </button>
          </div>
        </header>

        <ol className="room-steps" aria-label={tr("pitchSteps")} hidden={full && anySlide}>
          {steps.map((step, i) => (
            <li
              key={step.title}
              className={`room-step${step.done ? " is-done" : ""}${step.active ? " is-active" : ""}`}
              aria-current={i === currentStep ? "step" : undefined}
            >
              <span className="room-step-dot" aria-hidden>
                {step.done ? <CheckGlyph /> : i + 1}
              </span>
              <span className="room-step-copy">
                <strong>{tr(step.title)}</strong>
                <span>{step.done ? tr("stepDone") : tr(step.hint)}</span>
              </span>
            </li>
          ))}
        </ol>

        <div className="desk-stage">
          <section className="room-card room-slide" aria-labelledby={`${folder.id}-slide`}>
            <div className="room-card-head">
              <span className="room-badge" aria-hidden>
                1
              </span>
              <h2 id={`${folder.id}-slide`}>{tr("slide")}</h2>
              <div className="room-card-tools">
                {figmaEmbed && hasSlide && (
                  <button type="button" className="desk-link" onClick={() => setPreferPdf((p) => !p)}>
                    {showFigma ? tr("showPdf") : tr("showFigma")}
                  </button>
                )}
                {folder.figmaUrl && (
                  <button type="button" className="desk-link" onClick={removeFigma}>
                    {tr("figmaRemove")}
                  </button>
                )}
                {hasSlide && (
                  <label className="desk-link">
                    {tr("changeSlide")}
                    <input type="file" accept={SLIDE_ACCEPT} className="sr-only" onChange={(e) => chooseSlide(e.target.files?.[0])} />
                  </label>
                )}
              </div>
            </div>
            <div className="desk-slide-slot">
              <div
                className={`desk-slide-frame${full && anySlide ? (showFigma ? " desk-full desk-full-figma" : " desk-full") : ""}`}
                data-coach={coachState ?? undefined}
              >
                {cameraOn && (
                  <PoseCoach slide={coach.side} slideId={page} onSwipe={swipeSlide} onState={setCoachState} />
                )}
                {showFigma ? (
                  <div className="desk-slide desk-figma">
                    <iframe src={figmaEmbed!} title={tr("figmaLive")} allow="fullscreen" allowFullScreen />
                  </div>
                ) : slidePdf ? (
                  <div ref={frameRef} className="desk-slide">
                    <canvas ref={canvasRef} width={1920} height={1080} />
                  </div>
                ) : slideUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="desk-slide" src={slideUrl} alt={folder.slideName ?? tr("figmaSlide")} />
                ) : (
                  <label className="desk-slide-empty room-slide-empty">
                    <span className="room-slide-empty-icon" aria-hidden>
                      <PlusGlyph size={18} />
                    </span>
                    <strong>{tr("landingStep1Title")}</strong>
                    <span>{tr("roomStep1Hint")}</span>
                    <input
                      type="file"
                      accept={SLIDE_ACCEPT}
                      className="sr-only"
                      onChange={(e) => chooseSlide(e.target.files?.[0])}
                    />
                  </label>
                )}
                {!full && (
                  <div className="desk-speak">
                    {speakButton()}
                    {cameraButton()}
                  </div>
                )}
                {!full && anySlide && (
                  <div className="desk-present-toggles">
                    <button type="button" className="room-glass-btn desk-full-toggle" onClick={() => void openPresent()}>
                      <PresentGlyph />
                      {tr("present")}
                    </button>
                  </div>
                )}
                {full && anySlide && (
                  <div className="desk-full-bar">
                    {speakButton()}
                    {cameraButton()}
                    {!showFigma && pageButtons()}
                    <button type="button" className="room-glass-btn room-icon-only" aria-label={tr("close")} onClick={() => setFull(false)}>
                      <CloseGlyph />
                    </button>
                  </div>
                )}
              </div>
            </div>
            {!full && (
              <div className="room-slide-bar">
                <label className="room-select">
                  <span>{tr("coachSide")}</span>
                  <select
                    value={coach.side}
                    onChange={(e) => saveCoachPrefs({ side: e.target.value === "left" ? "left" : "right" })}
                  >
                    <option value="left">{tr("coachSideLeft")}</option>
                    <option value="right">{tr("coachSideRight")}</option>
                  </select>
                </label>
                {!showFigma && pageButtons()}
              </div>
            )}
            {!full && (cameraOn || showFigma || slideNote || slideMsg || presentNote) && (
              <div className="room-slide-notes">
                {cameraOn && <p className="desk-hint">{tr("coachSwipeHint")}</p>}
                {showFigma && (
                  <p className="desk-hint">
                    {tr("figmaShareHint")}
                    {!hasSlide && ` ${tr("figmaNeedsPdf")}`}
                  </p>
                )}
                {slideNote && <p className="desk-note">{tr(slideNote)}</p>}
                {slideMsg && <p className="desk-note" aria-live="polite">{slideMsg}</p>}
                {presentNote && (
                  <p className="desk-hint" aria-live="polite">
                    {presentNote}
                  </p>
                )}
              </div>
            )}
          </section>

          <aside className="desk-speech room-card room-speech" aria-labelledby={`${folder.id}-speech`}>
            <div className="room-card-head">
              <span className="room-badge" aria-hidden>
                2
              </span>
              <h2 id={`${folder.id}-speech`}>{tr("speechText")}</h2>
              {speechStatus && (
                <span className={`room-status ${speechStatus.tone}`} role="status">
                  {speechStatus.text}
                </span>
              )}
            </div>
            <div className="desk-speech-body">
              {spoken ? (
                <>
                  <p ref={previewRef} className={previewCut ? "desk-transcript desk-transcript-preview is-cut" : "desk-transcript desk-transcript-preview"}>
                    {transcript.text}
                    {(listening || pending > 0) && <span className="desk-speech-pending"> …</span>}
                  </p>
                  {(transcript.long || previewCut) && (
                    <button
                      type="button"
                      className="desk-link desk-transcript-toggle"
                      aria-haspopup="dialog"
                      onClick={() => setTranscriptOpen(true)}
                    >
                      {tr("seeMore")}
                    </button>
                  )}
                  {transcriptOpen &&
                    createPortal(
                      <Modal title={tr("speechText")} onClose={() => setTranscriptOpen(false)} wide>
                        <p ref={transcriptRef} className="desk-transcript desk-transcript-full" tabIndex={0}>
                          {spoken}
                          {(listening || pending > 0) && <span className="desk-speech-pending"> …</span>}
                        </p>
                      </Modal>,
                      document.body,
                    )}
                </>
              ) : (
                <div className="desk-speech-empty">
                  <span className="room-empty-icon">
                    <SpeechMark />
                  </span>
                  <p>{listening ? tr("listening") : pending > 0 || fileBusy ? tr("transcribing") : tr("noSpeechYet")}</p>
                  <span>
                    {listening ? tr("listeningLong") : pending > 0 || fileBusy ? tr("transcribing") : tr("noSpeechHint")}
                  </span>
                </div>
              )}
            </div>
            {sttNote && <p className="desk-note">{sttNote}</p>}
            <div className="desk-speech-tools">
              <button
                type="button"
                disabled={!folder.audioName || fileBusy || listening}
                onClick={() => void transcribeAudioFile()}
              >
                {fileBusy ? tr("transcribingAudio") : tr("retranscribeAudio")}
              </button>
              <button type="button" disabled={!spoken || listening} onClick={() => writeSpeech("")}>
                {tr("clearText")}
              </button>
            </div>
            <div className="room-analyze">
              <div className="room-analyze-head">
                <span className="room-badge" aria-hidden>
                  3
                </span>
                <span>{tr("landingStep3Title")}</span>
              </div>
              <button
                type="button"
                className="room-analyze-btn"
                disabled={probing || !folder.audioName}
                onClick={() => void sendToModel()}
              >
                {locked ? <LockGlyph /> : <SparkGlyph />}
                {probing ? tr("sending") : tr("sendToModel")}
              </button>
              {probing && analysisStep && <AnalysisProgress step={analysisStep} />}
              {probeNote && <p className="desk-note">{probeNote}</p>}
              {probeResult && !resultOpen && (
                <button type="button" className="room-result-btn" onClick={() => setResultOpen(true)}>
                  {tr("showResult")}
                  <ChevronGlyph dir="right" />
                </button>
              )}
            </div>
            {probeResult &&
              resultOpen &&
              createPortal(
                <Modal title={tr("analysisResult")} onClose={() => setResultOpen(false)} wide>
                  <div className="desk-probe desk-probe-dialog" aria-live="polite">
                    <p>
                      {/* While the answer is coming in, say what's happening rather than the model's name. */}
                      {probeResult.writing ? tr("writing") : modelLabel(probeResult.model)}
                      {probeResult.received && (
                        <>
                          {" · "}
                          {probeResult.received.text ? tr("text") : tr("noText")}
                          {probeResult.received.audio ? ` · ${tr("audio")} ${probeResult.received.audio}` : ""}
                          {probeResult.received.slide ? ` · ${tr("slide")} ${probeResult.received.slide}` : ""}
                        </>
                      )}
                    </p>
                    {/* The GPU PC couldn't be used for part of this analysis: say what stood in. */}
                    {(probeResult.fallbacks ?? []).map((f) => (
                      <p key={f.part} className="desk-fallback-note" role="note">
                        {f.part === "speech_to_text"
                          ? tr("fallbackSpeech", { used: f.used === "duudlaga" ? "Duudlaga" : f.used })
                          : tr("fallbackFeedback", { used: modelLabel(f.used) })}
                      </p>
                    ))}
                    <FeedbackResult
                      summary={probeResult.summary}
                      strengths={probeResult.strengths}
                      improvements={probeResult.improvements}
                      offTopic={probeResult.offTopic}
                      mainPoints={probeResult.mainPoints}
                      pointSlides={probeResult.pointSlides}
                      writing={probeResult.writing}
                      speak={probeResult.writing ? undefined : speakText}
                      hearOwn={hearOwn}
                      readAll={readResult}
                      reading={reading}
                    />
                  </div>
                </Modal>,
                document.body,
              )}
          </aside>

          <div className="desk-below">
            <PitchPointsEditor
              idea={folder.idea ?? ""}
              points={folder.keyPoints ?? []}
              slides={folder.pointSlides ?? []}
              slideCount={showFigma ? 0 : pageCount}
              currentSlide={!showFigma && pageCount > 0 ? page : null}
              transitions={showFigma ? [] : transitions}
              onChange={({ idea, points, slides }) => onChange({ ...folder, idea, keyPoints: points, pointSlides: slides })}
            />

            <section className="folder-audios room-card" aria-labelledby={`${folder.id}-audios`}>
              <div className="folder-audios-bar">
                <h2 id={`${folder.id}-audios`}>{tr("audio")}</h2>
                <span className="section-head-actions">
                {!audiosHidden && (
                <label
                  className="room-glass-btn"
                  onClick={(event) => {
                    if (!locked) return;
                    event.preventDefault();
                    notifySubscriptionRequired();
                  }}
                >
                  {locked ? <LockGlyph /> : <PlusGlyph />}
                  {tr("addAudio")}
                  <input
                    type="file"
                    accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
                    className="sr-only"
                    onChange={(e) => {
                      void chooseAudio(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                )}
                <SectionToggle hidden={audiosHidden} onToggle={toggleAudios} controls={`${folder.id}-audios-body`} label={tr("audio")} />
                </span>
              </div>
              <div id={`${folder.id}-audios-body`} hidden={audiosHidden}>
              {(folder.audios ?? []).length === 0 ? (
                <p className="folder-audio-empty">{tr("noAudioYet")}</p>
              ) : (
                <ul>
                  {(folder.audios ?? []).map((audio) => (
                    <FolderAudioFile
                      key={audio.id}
                      audio={audio}
                      selected={audio.id === folder.audioId}
                      onSelect={() => pickSaved(audio.id)}
                      onRemove={() => void dropAudio(audio.id)}
                    />
                  ))}
                </ul>
              )}
              </div>
            </section>

            <TakeHistory folderId={folder.id} version={takesVersion} />
          </div>
        </div>

        {confirmDelete && (
          <Modal title={tr("deleteFolderTitle", { name: folder.name })} onClose={() => setConfirmDelete(false)}>
            <p className="folder-delete-text">{tr("deleteFolderText")}</p>
            <div className="app-modal-actions folder-delete-actions">
              <button type="button" className="ui-btn" onClick={() => setConfirmDelete(false)}>
                {tr("cancel")}
              </button>
              <button type="button" className="folder-delete-btn is-confirm" autoFocus onClick={onDelete}>
                {tr("deleteFolder")}
              </button>
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}

function latestUpdated(folder: FolderMeta): string | null {
  const stamps = [folder.slide?.createdAt, ...(folder.audios ?? []).map((audio) => audio.createdAt)].filter(
    (stamp): stamp is string => Boolean(stamp),
  );
  if (stamps.length === 0) return null;
  const newest = stamps.sort().at(-1);
  if (!newest) return null;
  const date = new Date(newest);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

async function figmaThumbnail(link: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/figma-thumbnail?url=${encodeURIComponent(link)}`);
    if (!res.ok) return null;
    return ((await res.json()) as { thumbnailUrl: string | null }).thumbnailUrl;
  } catch {
    return null;
  }
}

function FolderCard({ folder, onOpen, onDelete }: { folder: FolderMeta; onOpen: () => void; onDelete: () => void }) {
  const { tr } = useLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [pdf, setPdf] = useState(false);
  const [empty, setEmpty] = useState(false);
  const title = folder.name; // the pitch's own name, which the sidebar can rename
  const updated = latestUpdated(folder);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    let doc: PDFDocumentProxy | null = null;
    void (async () => {
      const blob = await getFolderBlob(folder.slide?.storageKey ?? slideKey(folder.id));
      if (cancelled) return;
      setImageUrl(null);
      setPdf(false);
      setEmpty(false);
      if (!blob) {
        // No slide file: show the Figma deck's cover image, when its link is shared publicly.
        const thumbnail = folder.figmaUrl ? await figmaThumbnail(folder.figmaUrl) : null;
        if (cancelled) return;
        if (thumbnail) setImageUrl(thumbnail);
        else setEmpty(true);
        return;
      }
      if (!isPdf(blob)) {
        url = URL.createObjectURL(blob);
        if (!cancelled) setImageUrl(url);
        return;
      }
      try {
        doc = await openPdf(new Uint8Array(await blob.arrayBuffer()));
        if (cancelled || !canvasRef.current) return;
        setPdf(true);
        await paintPage(doc, 1, canvasRef.current, 480);
      } catch {
        // The card still opens the folder; it just shows no cover.
        if (!cancelled) setEmpty(true);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      void doc?.loadingTask.destroy().catch(() => undefined);
    };
  }, [folder.id, folder.slide?.storageKey, folder.slideName, folder.figmaUrl]);

  return (
    <li>
      <button type="button" className="folder-card" onClick={onOpen}>
        <span className="folder-card-cover">
          {imageUrl ? <img src={imageUrl} alt="" /> : <canvas ref={canvasRef} hidden={!pdf} />}
          {empty && (
            <span className="folder-card-placeholder">
              <span className="folder-ring" aria-hidden />
              <span>{tr("noSlide")}</span>
            </span>
          )}
        </span>
        <span className="folder-card-info">
          <span className="folder-card-text">
            <strong>{title}</strong>
            <span className="folder-card-meta">
              {tr("audioCount", { n: folder.audios?.length ?? 0 })}
              {updated && ` · ${updated}`}
            </span>
          </span>
          <ArrowGlyph />
        </span>
      </button>
      {/* A sibling of the card, not inside it: a button can't contain another button. */}
      <button
        type="button"
        className="folder-card-delete"
        aria-label={tr("deleteFolderTitle", { name: title })}
        title={tr("deleteFolder")}
        onClick={onDelete}
      >
        <CloseGlyph />
      </button>
    </li>
  );
}

function FolderAudioFile({
  audio,
  selected,
  onSelect,
  onRemove,
}: {
  audio: FolderAudio;
  selected: boolean;
  onSelect: () => void;
  onRemove: () => void;
}) {
  const { tr } = useLang();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let object: string | null = null;
    void getFolderBlob(audio.storageKey).then((blob) => {
      if (cancelled || !blob) return;
      object = URL.createObjectURL(blob);
      setUrl(object);
    });
    return () => {
      cancelled = true;
      if (object) URL.revokeObjectURL(object);
    };
  }, [audio.storageKey]);

  const meta = [audio.fileType, audio.durationS != null ? formatClock(audio.durationS) : null, audio.createdAt ? audio.createdAt.slice(0, 10) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className={selected ? "is-on" : undefined}>
      <div className="folder-audio-head">
        <button type="button" onClick={onSelect} aria-current={selected ? "true" : undefined}>
          {audio.filename}
        </button>
        <button type="button" className="ui-link" onClick={onRemove}>
          {tr("removeAudio")}
        </button>
      </div>
      {meta && <p className="ui-help">{meta}</p>}
      {url && <audio controls preload="metadata" src={url} />}
    </li>
  );
}

function SpeechMark() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <rect x="10" y="3.5" width="8" height="12" rx="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M7 13.5a7 7 0 0 0 14 0M14 20.5v3.5M10.5 24h7" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function ArrowGlyph() {
  return (
    <svg className="folder-card-arrow" width="18" height="18" viewBox="0 0 18 18" aria-hidden>
      <path d="M4 9h10M10 5l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
      <path d="M3 3l6 6M9 3l-6 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ChevronGlyph({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path
        d={dir === "left" ? "M8.5 2.5 4 7l4.5 4.5" : "M5.5 2.5 10 7l-4.5 4.5"}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CheckGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <path d="m3 7.3 2.6 2.6L11 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function CameraGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <rect x="1.5" y="4" width="9" height="8" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="m10.5 7 4-2.2v6.4l-4-2.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

function PresentGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
      <rect x="1.5" y="2" width="11" height="7.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M4 12h6M7 9.5V12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function LinkGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M6.5 9.5a3 3 0 0 0 4.2 0l2.3-2.3a3 3 0 0 0-4.2-4.2l-.9.9M9.5 6.5a3 3 0 0 0-4.2 0L3 8.8A3 3 0 0 0 7.2 13l.9-.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SparkGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path d="M8 1.5 9.4 6.6 14.5 8l-5.1 1.4L8 14.5 6.6 9.4 1.5 8l5.1-1.4L8 1.5Z" fill="currentColor" />
    </svg>
  );
}

function LockGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <rect x="2.75" y="6.25" width="8.5" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.75 6.25V4.5a2.25 2.25 0 0 1 4.5 0v1.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function PlusGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" aria-hidden>
      <path d="M7 2v10M2 7h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

