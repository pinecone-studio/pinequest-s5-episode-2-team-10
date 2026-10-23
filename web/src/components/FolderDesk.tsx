"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  attachAudio,
  attachSlide,
  audioFileError,
  deleteFolderBlob,
  detachAudio,
  getFolderBlob,
  loadFolders,
  loadSpeech,
  putFolderBlob,
  saveFolders,
  saveSpeech,
  selectAudio,
  selectedAudio,
  slideKey,
  type FolderAudio,
  type FolderMeta,
} from "@/lib/folderStore";
import { figmaEmbedUrl } from "@/lib/figmaEmbed";
import { openPdf, paintPage, pickSlides, readSlideText } from "@/lib/slidePdf";
import { runBackendAnalysis } from "@/lib/backendAnalysis";
import { streamModelReply } from "@/lib/modelStream";
import { prepareSlide, SLIDE_ACCEPT, slideKind } from "@/lib/slideFiles";
import { PieceRecorder, transcribeBlob } from "@/lib/voiceRecorder";
import { langHeaders, useLang } from "@/lib/i18nClient";
import DevTests from "./DevTests";
import Modal from "./Modal";
import ImprovementList, { type Improvement, type OffTopic, type Strength } from "./ImprovementList";
import { PitchPointsEditor, PitchPointsResult, type MainPointsResult } from "./PitchPoints";
import FeedbackModelSelect, { useFeedbackModel } from "./FeedbackModelSelect";

type Live = { stream: MediaStream; ctx: AudioContext };

function closeLive(live: Live | null) {
  live?.stream.getTracks().forEach((track) => track.stop());
  void live?.ctx.close();
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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
  const [ready, setReady] = useState(false);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [slideFile, setSlideFile] = useState<File | null>(null);
  const [creating, setCreating] = useState(false);
  const [newSlideError, setNewSlideError] = useState<string | null>(null);

  async function pickNewSlide(file: File | null) {
    setNewSlideError(null);
    setSlideFile(file);
    if (file && !(await slideKind(file))) setNewSlideError(tr("slideWrongType"));
  }

  useEffect(() => {
    setFolders(loadFolders());
    setReady(true);
  }, []);

  function persist(next: FolderMeta[]) {
    setFolders(next);
    saveFolders(next);
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const name = draft.trim();
    if (!name || !slideFile) return;
    setCreating(true);
    setNewSlideError(null);
    let slide: File;
    try {
      slide = await prepareSlide(slideFile); // PowerPoint decks become PDF here
    } catch (err) {
      setNewSlideError(err instanceof Error ? err.message : tr("deckConvertFailed"));
      setCreating(false);
      return;
    }
    setCreating(false);
    const id = crypto.randomUUID();
    const folder = attachSlide(
      { id, name, slideName: null, audioName: null },
      { name: slide.name, type: slide.type },
      new Date().toISOString(),
    );
    await putFolderBlob(slideKey(folder.id), slide);
    persist([folder, ...folders]);
    setDraft("");
    setSlideFile(null);
    setNaming(false);
    setOpenId(folder.id);
  }

  const open = folders.find((f) => f.id === openId) ?? null;

  if (!ready) return <div className="desk" />;

  if (!open) {
    return (
      <div className="desk folder-board">
        <div className="desk-col">
          <div className="desk-title">
            <div>
              <h1>{tr("folders")}</h1>
              <p className="desk-sub">
                {folders.length === 0 ? tr("foldersNone") : tr("foldersCount", { n: folders.length })}
              </p>
            </div>
            <button type="button" className="desk-primary" onClick={() => setNaming(true)}>
              {tr("addFolder")}
            </button>
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
                <label>
                  <span>{tr("slide")}</span>
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
                <div className="app-modal-actions">
                  <button
                    type="submit"
                    className="desk-primary"
                    disabled={!draft.trim() || !slideFile || creating || Boolean(newSlideError)}
                  >
                    {creating ? tr("convertingSlide") : tr("createOpen")}
                  </button>
                </div>
              </form>
            </Modal>
          )}

          {folders.length === 0 ? (
            <p className="desk-empty">{tr("foldersEmpty")}</p>
          ) : (
            <ul className="folder-grid">
              {folders.map((folder) => (
                <FolderCard key={folder.id} folder={folder} onOpen={() => setOpenId(folder.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <FolderRoom
      folder={open}
      onBack={() => setOpenId(null)}
      onChange={(next) => persist(folders.map((f) => (f.id === next.id ? next : f)))}
    />
  );
}

function FolderRoom({
  folder,
  onBack,
  onChange,
}: {
  folder: FolderMeta;
  onBack: () => void;
  onChange: (folder: FolderMeta) => void;
}) {
  const { tr } = useLang();
  const audioRef = useRef<HTMLAudioElement | null>(null);
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
  // A Figma link plays the deck live (with its animations); the PDF still feeds the analysis.
  const [figmaEditing, setFigmaEditing] = useState(false);
  const [figmaDraft, setFigmaDraft] = useState("");
  const [figmaError, setFigmaError] = useState(false);
  const [preferPdf, setPreferPdf] = useState(false);
  const figmaEmbed = folder.figmaUrl ? figmaEmbedUrl(folder.figmaUrl) : null;
  const showFigma = !!figmaEmbed && !(preferPdf && hasSlide);
  const anySlide = hasSlide || !!figmaEmbed;
  const [pdfEpoch, setPdfEpoch] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [listening, setListening] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [finalText, setFinalText] = useState("");
  const textRef = useRef("");
  const [sttNote, setSttNote] = useState<string | null>(null);
  const [slideNote, setSlideNote] = useState<"pdfOpenFail" | "slideDrawFail" | null>(null);
  const [slideMsg, setSlideMsg] = useState<string | null>(null); // converting, or why a picked file was refused
  const [full, setFull] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<{
    summary: string;
    strengths: Strength[];
    improvements: Improvement[];
    offTopic: OffTopic[];
    model: string;
    mainPoints: MainPointsResult | null;
    received: { text: boolean; audio: string | null; slide: string | null } | null;
    writing: boolean; // true while the model is still writing (shown as it arrives, not checked yet)
  } | null>(null);

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
      setPage(1);
      rememberUrl(URL.createObjectURL(file));
      setSlideNote(null);
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
      setPage(1);
      setPdfEpoch((n) => n + 1);
      const picked = await pickSlides(doc).catch(() => null);
      if (picked && slideGen.current === gen && picked.hidden > 0) {
        setShownPages(picked.pages);
        setHiddenPages(picked.hidden);
        setPageCount(picked.pages.length);
        setPage(1);
      }
    } catch {
      if (slideGen.current !== gen) return;
      setSlideNote("pdfOpenFail");
    }
  }

  useEffect(() => {
    let audioObject: string | null = null;
    let cancelled = false;
    aliveRef.current = true;

    (async () => {
      const saved = selectedAudio(folder);
      const [slide, audio] = await Promise.all([
        getFolderBlob(slideKey(folder.id)),
        saved ? getFolderBlob(saved.storageKey) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      if (slide) await loadSlide(slide);
      else {
        setHasSlide(false);
        setSlidePdf(false);
        setPageCount(0);
        setShownPages([]);
        setHiddenPages(0);
        rememberUrl(null);
        setSlideNote(null);
      }
      if (cancelled) return;
      if (audio) {
        audioObject = URL.createObjectURL(audio);
        setAudioUrl(audioObject);
      } else setAudioUrl(null);
    })();

    return () => {
      cancelled = true;
      slideGen.current += 1;
      void pdfRef.current?.loadingTask.destroy().catch(() => undefined);
      pdfRef.current = null;
      if (slideUrlRef.current) URL.revokeObjectURL(slideUrlRef.current);
      slideUrlRef.current = null;
      if (audioObject) URL.revokeObjectURL(audioObject);
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
    const saved = loadSpeech(folder.id);
    textRef.current = saved ? `${saved} ` : "";
    setFinalText(textRef.current);
  }, [folder.id]);

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
  }, [pageCount]);

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
    setAnalyser(null);
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
    setAnalyser(node);
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
    const next = attachSlide(folder, { name: file.name, type: file.type }, new Date().toISOString());
    await putFolderBlob(next.slide?.storageKey ?? slideKey(folder.id), file);
    onChange(next);
    await loadSlide(file);
  }

  function replaceAudioUrl(next: string | null) {
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return next;
    });
    setTime(0);
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
  async function storeAudio(file: Blob, name: string, type: string): Promise<boolean> {
    const problem = audioFileError({ name, type, size: file.size });
    if (problem) {
      setSttNote(tr(problem === "size" ? "audioTooBig" : "audioWrongType"));
      return false;
    }
    const next = attachAudio(
      folder,
      { name, type, durationS: await readDuration(file) },
      crypto.randomUUID(),
      new Date().toISOString(),
    );
    const record = selectedAudio(next);
    if (!record) return false;
    await putFolderBlob(record.storageKey, file);
    if (!aliveRef.current) return false;
    onChange(next);
    replaceAudioUrl(URL.createObjectURL(file));
    setSttNote(null);
    return true;
  }

  async function chooseAudio(file: File | undefined) {
    if (!file) return;
    await storeAudio(file, file.name, file.type);
  }

  async function pickSaved(id: string) {
    const next = selectAudio(folder, id);
    onChange(next);
    const record = selectedAudio(next);
    const blob = record ? await getFolderBlob(record.storageKey) : null;
    if (!aliveRef.current) return;
    replaceAudioUrl(blob ? URL.createObjectURL(blob) : null);
  }

  async function dropAudio(id: string) {
    const { folder: next, storageKey } = detachAudio(folder, id);
    if (storageKey) await deleteFolderBlob(storageKey);
    onChange(next);
    const record = selectedAudio(next);
    const blob = record ? await getFolderBlob(record.storageKey) : null;
    if (!aliveRef.current) return;
    replaceAudioUrl(blob ? URL.createObjectURL(blob) : null);
  }

  /** Local test: uses the bundled Mongolian sample as the folder audio and transcribes it. */
  async function loadSample(audio: Blob): Promise<string> {
    stopStt();
    const stored = await storeAudio(audio, tr("sampleName"), audio.type || "audio/webm");
    if (!stored) return "";
    const reply = await transcribeBlob(audio, "mn-sample.webm");
    if (aliveRef.current) writeSpeech(reply.text);
    return tr("sampleLoaded", { n: reply.text.split(/\s+/).filter(Boolean).length });
  }

  function toggleSpeak() {
    if (playingRef.current) stopStt();
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

  async function sendToModel() {
    const speech = textRef.current.trim();
    setProbing(true);
    setProbeNote(null);
    setProbeResult(null);
    try {
      const saved = selectedAudio(folder);
      const [audio, slide] = await Promise.all([
        saved ? getFolderBlob(saved.storageKey) : Promise.resolve(null),
        getFolderBlob(slideKey(folder.id)),
      ]);
      if (model === "backend") {
        // The full FastAPI pipeline; it reports stages instead of streaming text.
        const result = await runBackendAnalysis({
          folder,
          speech,
          audio,
          slide,
          onStage: (stage) => setProbeNote(tr(stage === "connecting" ? "backendConnecting" : stage === "uploading" ? "backendUploading" : "backendAnalyzing")),
          messages: { noAudio: tr("backendNoAudio"), slideSkipped: tr("backendSlideSkipped") },
        });
        setProbeNote(result.notes.length ? result.notes.join(" ") : null);
        setProbeResult({ ...result, model, writing: false });
        return;
      }
      const slideText = pdfRef.current ? await readSlideText(pdfRef.current, 8, shownPages) : "";
      const slideImage = await new Promise<Blob | null>((resolve) => {
        const canvas = canvasRef.current;
        if (!canvas) {
          resolve(null);
          return;
        }
        canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.72);
      });
      const body = new FormData();
      body.set("text", speech);
      body.set("slideText", slideText);
      body.set("model", model);
      body.set("idea", folder.idea ?? "");
      body.set("keyPoints", JSON.stringify((folder.keyPoints ?? []).filter((p) => p.trim())));
      // Names only: the route needs the text, and hosts like Vercel reject bodies over 4.5 MB.
      if (audio) body.set("audioName", folder.audioName ?? "audio");
      if (slide) body.set("slideName", folder.slideName ?? "slide");
      if (slideImage) body.set("slideImage", slideImage, "current-slide.jpg");
      // Streamed: the summary and list fill in while the model writes; the checked reply replaces them.
      const payload = await streamModelReply(
        body,
        langHeaders(),
        (partial) =>
          setProbeResult({
            summary: partial.summary ?? "",
            strengths: partial.strengths ?? [],
            improvements: partial.improvements ?? [],
            offTopic: [],
            model,
            mainPoints: null,
            received: null,
            writing: true,
          }),
        tr("sendFail"),
      );
      if (!payload.summary || !payload.improvements || !payload.received) {
        setProbeResult(null);
        setProbeNote(tr("sendFail"));
        return;
      }
      setProbeResult({
        summary: payload.summary,
        strengths: payload.strengths ?? [],
        improvements: payload.improvements,
        offTopic: payload.offTopic ?? [],
        model: payload.model ?? model,
        mainPoints: (payload.mainPoints as MainPointsResult | null) ?? null,
        received: payload.received,
        writing: false,
      });
    } catch (err) {
      setProbeResult(null);
      setProbeNote(err instanceof Error && err.message ? err.message : tr("sendFail"));
    } finally {
      setProbing(false);
    }
  }

  function toggleAudio() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play();
    else el.pause();
  }

  const spoken = finalText.trim();
  function speakButton() {
    return (
      <button type="button" className={listening ? "desk-ghost" : "desk-primary"} onClick={toggleSpeak}>
        {listening && <span className="desk-rec" aria-hidden />}
        {listening ? tr("stop") : tr("speak")}
      </button>
    );
  }
  function pageButtons() {
    if (pageCount < 2) return null;
    return (
      <>
        <button type="button" className="desk-ghost" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
          {tr("prev")}
        </button>
        <span className="desk-count">
          {page} / {pageCount}
        </span>
        <button
          type="button"
          className="desk-ghost"
          disabled={page >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
        >
          {tr("next")}
        </button>
      </>
    );
  }

  return (
    <div className="desk folder-board">
      <div className="desk-col">
        <div className="desk-title">
          <div>
            <button type="button" className="desk-back" onClick={onBack}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M8.5 2.5 4 7l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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
        </div>
        <div className="desk-actions" hidden={full && anySlide}>
          {speakButton()}
          {anySlide && (
            <button type="button" className="desk-ghost" onClick={() => setFull(true)}>
              {tr("fullscreen")}
            </button>
          )}
        </div>

        <div className="desk-stage">
          <div>
            <div className={full && anySlide ? (showFigma ? "desk-full desk-full-figma" : "desk-full") : undefined}>
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
                <label className="desk-slide-empty">
                  <span>{tr("figmaSlide")}</span>
                  {tr("addImage")}
                  <input
                    type="file"
                    accept={SLIDE_ACCEPT}
                    className="sr-only"
                    onChange={(e) => chooseSlide(e.target.files?.[0])}
                  />
                </label>
              )}
              {full && anySlide && (
                <div className="desk-full-bar">
                  {speakButton()}
                  {!showFigma && pageButtons()}
                  <button type="button" className="desk-ghost" aria-label={tr("close")} onClick={() => setFull(false)}>
                    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
            {!full && (
              <div className="desk-tools">
                <div className="desk-pages">{!showFigma && pageButtons()}</div>
                <div className="desk-figma-tools">
                  {figmaEditing ? (
                    <form onSubmit={saveFigma} className="desk-figma-form">
                      <input
                        type="url"
                        value={figmaDraft}
                        onChange={(e) => setFigmaDraft(e.target.value)}
                        placeholder="https://www.figma.com/slides/…"
                        aria-label={tr("figmaLinkLabel")}
                        autoFocus
                      />
                      <button type="submit" className="desk-ghost">
                        {tr("figmaSave")}
                      </button>
                      <button type="button" className="desk-ghost" onClick={() => (setFigmaEditing(false), setFigmaError(false))}>
                        {tr("figmaCancel")}
                      </button>
                    </form>
                  ) : (
                    <>
                      {figmaEmbed && hasSlide && (
                        <button type="button" className="desk-link" onClick={() => setPreferPdf((p) => !p)}>
                          {showFigma ? tr("showPdf") : tr("showFigma")}
                        </button>
                      )}
                      <button
                        type="button"
                        className="desk-link"
                        onClick={() => (setFigmaDraft(folder.figmaUrl ?? ""), setFigmaEditing(true))}
                      >
                        {folder.figmaUrl ? tr("figmaChange") : tr("figmaAdd")}
                      </button>
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
                    </>
                  )}
                </div>
              </div>
            )}
            {figmaError && <p className="desk-note">{tr("figmaBad")}</p>}
            {showFigma && !full && (
              <p className="desk-hint">
                {tr("figmaShareHint")}
                {!hasSlide && ` ${tr("figmaNeedsPdf")}`}
              </p>
            )}
            {slideNote && <p className="desk-note">{tr(slideNote)}</p>}
            {slideMsg && <p className="desk-note" aria-live="polite">{slideMsg}</p>}
          </div>
          <aside className="desk-speech">
            <h2>{tr("speechText")}</h2>
            <p className="desk-sub" aria-live="polite">
              {listening
                ? tr("listeningLong")
                : pending > 0 || fileBusy
                  ? tr("transcribing")
                  : spoken
                    ? tr("speechSaved")
                    : tr("pressSpeak")}
            </p>
            <p className="desk-transcript">
              {spoken || (pending === 0 && <span className="desk-missing">{tr("empty")}</span>)}
              {pending > 0 && <span className="desk-missing"> …</span>}
            </p>
            {sttNote && <p className="desk-note">{sttNote}</p>}
            <div className="desk-speech-tools">
              <button
                type="button"
                className="desk-link"
                disabled={!folder.audioName || fileBusy || listening}
                onClick={() => void transcribeAudioFile()}
              >
                {fileBusy ? tr("transcribingAudio") : tr("retranscribeAudio")}
              </button>
              <button
                type="button"
                className="desk-link"
                disabled={!spoken || listening}
                onClick={() => writeSpeech("")}
              >
                {tr("clearText")}
              </button>
            </div>
            <div className="desk-probe">
              <FeedbackModelSelect value={model} onChange={setModel} />
              <button
                type="button"
                className="desk-ghost"
                disabled={probing || (!spoken && !folder.audioName && !hasSlide)}
                onClick={() => void sendToModel()}
              >
                {probing ? tr("sending") : tr("sendToModel")}
              </button>
              {probeNote && <p className="desk-note">{probeNote}</p>}
              {probeResult && (
                <>
                  <p>
                    {probeResult.model}
                    {probeResult.writing && ` · ${tr("writing")}`}
                    {probeResult.received && (
                      <>
                        {" · "}
                        {probeResult.received.text ? tr("text") : tr("noText")}
                        {probeResult.received.audio ? ` · ${tr("audio")} ${probeResult.received.audio}` : ""}
                        {probeResult.received.slide ? ` · ${tr("slide")} ${probeResult.received.slide}` : ""}
                      </>
                    )}
                  </p>
                  <h3>{probeResult.summary}</h3>
                  <ImprovementList
                    strengths={probeResult.strengths}
                    improvements={probeResult.improvements}
                    offTopic={probeResult.offTopic}
                  />
                  {probeResult.mainPoints && <PitchPointsResult result={probeResult.mainPoints} />}
                </>
              )}
            </div>
            {process.env.NODE_ENV === "development" && <DevTests model={model} onLoadSample={loadSample} />}
          </aside>
        </div>

        <PitchPointsEditor
          idea={folder.idea ?? ""}
          points={folder.keyPoints ?? []}
          onChange={({ idea, points }) => onChange({ ...folder, idea, keyPoints: points })}
        />

        <div>
        <WaveAudio
          url={audioUrl}
          name={folder.audioName}
          playing={playing}
          live={analyser}
          time={time}
          duration={duration}
          onToggle={toggleAudio}
          onPick={chooseAudio}
        />
        <section className="folder-audios" aria-labelledby={`${folder.id}-audios`}>
          <div className="folder-audios-bar">
            <h2 id={`${folder.id}-audios`}>{tr("audio")}</h2>
            <label className="ui-btn">
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
          </div>
          {(folder.audios ?? []).length === 0 ? (
            <p className="folder-audio-empty">{tr("noAudioYet")}</p>
          ) : (
            <ul>
              {(folder.audios ?? []).map((audio) => (
                <FolderAudioFile
                  key={audio.id}
                  audio={audio}
                  selected={audio.id === folder.audioId}
                  onSelect={() => void pickSaved(audio.id)}
                  onRemove={() => void dropAudio(audio.id)}
                />
              ))}
            </ul>
          )}
        </section>
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />
        </div>
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

function FolderCard({ folder, onOpen }: { folder: FolderMeta; onOpen: () => void }) {
  const { tr } = useLang();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [pdf, setPdf] = useState(false);
  const title = folder.slide?.title || folder.slideName || folder.name;
  const updated = latestUpdated(folder);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    let doc: PDFDocumentProxy | null = null;
    setImageUrl(null);
    setPdf(false);
    void (async () => {
      const blob = await getFolderBlob(slideKey(folder.id));
      if (cancelled) return;
      if (!blob) {
        // No slide file: show the Figma deck's cover image, when its link is shared publicly.
        if (!folder.figmaUrl) return;
        const thumbnail = await figmaThumbnail(folder.figmaUrl);
        if (!cancelled && thumbnail) setImageUrl(thumbnail);
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
        /* the card still opens the folder */
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
        <span className="folder-card-preview">
          {imageUrl ? <img src={imageUrl} alt="" /> : <canvas ref={canvasRef} hidden={!pdf} />}
        </span>
        <span className="folder-card-body">
          <strong>{title}</strong>
          <span className="folder-card-meta">
            <FolderGlyph />
            <span>{tr("audioCount", { n: folder.audios?.length ?? 0 })}</span>
          </span>
          {updated && <time dateTime={updated}>{updated}</time>}
        </span>
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

function FolderGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <path
        d="M2 3.5h4l1.2 1.5H14v7.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function FolderMark() {
  return (
    <svg width="28" height="18" viewBox="0 0 28 18" aria-hidden className="shrink-0" style={{ color: "var(--muted)" }}>
      <rect x="0.75" y="0.75" width="26.5" height="16.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6 9h2l1.2-3 2 6 2-4 1.2 1.5H22" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

const SAMPLE_WAVE = [0.12, 0.4, -0.2, 0.62, 0.95, 0.25, -0.45, 0.7, -0.15, 0.5, -0.6, 0.22, 0.58, -0.08, 0.33, -0.4, 0.18, 0.46, -0.22, 0.12];

function wavePath(peaks: number[]) {
  const w = 640;
  const h = 160;
  const mid = h / 2;
  const step = w / Math.max(1, peaks.length - 1);
  return peaks
    .map((peak, i) => {
      const y = mid - peak * (mid - 12);
      return `${i === 0 ? "M" : "L"}${+(i * step).toFixed(1)},${+y.toFixed(1)}`;
    })
    .join(" ");
}

function PlayMark() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden className="ml-0.5">
      <path fill="currentColor" d="M4 2.2v9.6l8-4.8-8-4.8Z" />
    </svg>
  );
}

function livePeaksFrom(analyser: AnalyserNode, data: Uint8Array<ArrayBuffer>) {
  analyser.getByteTimeDomainData(data);
  const count = 32;
  const block = Math.floor(data.length / count);
  const next: number[] = [];
  for (let i = 0; i < count; i++) {
    const sample = (data[i * block + Math.floor(block / 2)] - 128) / 128;
    next.push(Math.max(-1, Math.min(1, sample * 1.8)));
  }
  return next;
}

function WaveAudio({
  url,
  name,
  playing,
  live,
  time,
  duration,
  onToggle,
  onPick,
}: {
  url: string | null;
  name: string | null;
  playing: boolean;
  live: AnalyserNode | null;
  time: number;
  duration: number;
  onToggle: () => void;
  onPick: (file: File | undefined) => void;
}) {
  const { tr } = useLang();
  const clipId = useId().replace(/:/g, "");
  const [peaks, setPeaks] = useState<number[]>(SAMPLE_WAVE);
  const [spoken, setSpoken] = useState<number[] | null>(null);
  const progress = live ? 1 : duration > 0 ? Math.min(1, time / duration) : 0;
  const d = wavePath(spoken ?? peaks);

  useEffect(() => {
    if (!url) return setPeaks(SAMPLE_WAVE);
    let cancelled = false;
    (async () => {
      try {
        const buf = await (await fetch(url)).arrayBuffer();
        const Ctx = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const audio = await ctx.decodeAudioData(buf.slice(0));
        const data = audio.getChannelData(0);
        const count = 96;
        const block = Math.max(1, Math.floor(data.length / count));
        const next: number[] = [];
        for (let i = 0; i < count; i++) {
          let sum = 0;
          let n = 0;
          for (let j = 0; j < block; j += 8) {
            sum += data[i * block + j] || 0;
            n++;
          }
          next.push(sum / Math.max(1, n));
        }
        const top = Math.max(...next.map((v) => Math.abs(v)), 0.01);
        if (!cancelled) setPeaks(next.map((v) => v / top));
        await ctx.close();
      } catch {
        if (!cancelled) setPeaks(SAMPLE_WAVE);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!live) return;
    const data = new Uint8Array(live.fftSize);
    let raf = 0;
    let last = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 180) return;
      last = now;
      setSpoken(livePeaksFrom(live, data));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setSpoken(null);
    };
  }, [live]);

  return (
    <div className="ui-wave">
      <button type="button" onClick={url && !live ? onToggle : undefined} className="relative block w-full px-4 pb-4 pt-6 text-left" disabled={!url || Boolean(live)}>
        <svg viewBox="0 0 640 160" className="h-28 w-full" aria-hidden>
          <path d={d} fill="none" stroke="#333436" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          <path
            d={d}
            fill="none"
            stroke="#e6e6e6"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            clipPath={`url(#${clipId})`}
          />
          <clipPath id={clipId}>
            <rect width={640 * progress} height="160" />
          </clipPath>
        </svg>
        <span className="absolute bottom-4 left-4 flex h-8 w-8 items-center justify-center rounded-full border border-[#333436] bg-[#1a1b1c] text-[#e6e6e6]">
          {playing ? <span className="h-2.5 w-2.5 rounded-sm bg-[#e6e6e6]" /> : <PlayMark />}
        </span>
      </button>
      <div className="ui-wave-foot">
        <span className="truncate">{name ?? tr("audio")}</span>
        <span className="shrink-0 tabular-nums">
          {live ? tr("listening") : url ? `${formatClock(time)} / ${formatClock(duration)}` : tr("noFile")}
        </span>
        <label className="shrink-0 cursor-pointer underline">
          {tr("upload")}
          <input
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
            className="sr-only"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
        </label>
      </div>
    </div>
  );
}
