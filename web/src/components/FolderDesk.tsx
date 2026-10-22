"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  audioKey,
  getFolderBlob,
  loadFolders,
  loadSpeech,
  putFolderBlob,
  saveFolders,
  saveSpeech,
  slideKey,
  type FolderMeta,
} from "@/lib/folderStore";
import { api, ApiRequestError, USING_MOCK } from "@/lib/api";
import { openPdf, paintPage, readSlideText } from "@/lib/slidePdf";

interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechEventLike {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}

interface SpeechRec {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: SpeechEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

function getRecognizer(): SpeechRec | null {
  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRec;
    webkitSpeechRecognition?: new () => SpeechRec;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = "mn-MN";
  rec.continuous = true;
  rec.interimResults = true;
  return rec;
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

function deckName(file: Blob, fallback: string | null) {
  const named = (file instanceof File ? file.name : fallback ?? "").toLowerCase();
  if (file.type === "application/pdf" || named.endsWith(".pdf")) return fallback?.toLowerCase().endsWith(".pdf") ? fallback : "slides.pdf";
  if (named.endsWith(".pptx") || file.type === "application/vnd.openxmlformats-officedocument.presentationml.presentation") {
    return fallback?.toLowerCase().endsWith(".pptx") ? fallback : "slides.pptx";
  }
  return null;
}

async function waitForReport(id: string) {
  for (let i = 0; i < 30; i++) {
    const status = await api.status(id);
    if (status.status === "completed") return api.report(id);
    if (status.status === "failed") {
      throw new ApiRequestError({ code: "failed", message: status.error || "Шинжилгээ амжилтгүй." }, 500);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new ApiRequestError({ code: "timeout", message: "Backend хариу удаан байна." }, 504);
}

function audioNameOf(file: Blob, fallback: string | null) {
  const named = fallback ?? (file instanceof File ? file.name : "");
  if (/\.(wav|mp3|m4a|webm|ogg)$/i.test(named)) return named;
  if (file.type.includes("mpeg")) return "audio.mp3";
  if (file.type.includes("wav")) return "audio.wav";
  if (file.type.includes("mp4") || file.type.includes("m4a")) return "audio.m4a";
  if (file.type.includes("ogg")) return "audio.ogg";
  if (file.type.includes("webm")) return "audio.webm";
  return named || null;
}

function isCancel(err: unknown) {
  return err instanceof Error && /cancel/i.test(`${err.name} ${err.message}`);
}

export default function FolderDesk() {
  const [ready, setReady] = useState(false);
  const [folders, setFolders] = useState<FolderMeta[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [draft, setDraft] = useState("");
  const [slideFile, setSlideFile] = useState<File | null>(null);

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
    const folder: FolderMeta = {
      id: crypto.randomUUID(),
      name,
      slideName: slideFile.name,
      audioName: null,
    };
    await putFolderBlob(slideKey(folder.id), slideFile);
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
      <div className="desk">
        <div className="desk-col">
          <div className="desk-bar">
            <WaveMark />
            <span>Pitch Coach</span>
          </div>
          <div className="desk-title">
            <div>
              <h1>Хавтаснууд</h1>
              <p className="desk-sub">
                {folders.length === 0 ? "Одоогоор хавтас алга." : `${folders.length} хавтас.`}
              </p>
            </div>
            {!naming && (
              <button type="button" className="desk-primary" onClick={() => setNaming(true)}>
                Хавтас нэмэх
              </button>
            )}
          </div>

          {naming && (
            <form onSubmit={createFolder} className="desk-panel">
              <label>
                <span>Хавтасны нэр</span>
                <input
                  type="text"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="figma tdd"
                />
              </label>
              <label>
                <span>Слайд</span>
                <span className="desk-file">
                  <span>{slideFile ? slideFile.name : "TDD слайдаа оруул"}</span>
                  <span>{slideFile ? "Солих" : "Оруулах"}</span>
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    className="sr-only"
                    onChange={(e) => setSlideFile(e.target.files?.[0] ?? null)}
                  />
                </span>
              </label>
              <button type="submit" className="desk-primary" disabled={!draft.trim() || !slideFile}>
                Үүсгээд орох
              </button>
            </form>
          )}

          {folders.length === 0 ? (
            <p className="desk-empty">Хавтас алга. Нэр өгөөд слайдаа оруул.</p>
          ) : (
            <ul className="desk-list">
              {folders.map((folder) => (
                <li key={folder.id}>
                  <button type="button" className="desk-row" onClick={() => setOpenId(folder.id)}>
                    <FolderMark />
                    <span>
                      <strong>{folder.name}</strong>
                      <em>{folder.slideName ?? "Слайд оруулаагүй"}</em>
                    </span>
                  </button>
                </li>
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
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const recRef = useRef<SpeechRec | null>(null);
  const playingRef = useRef(false);
  const sttGen = useRef(0);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const slideGen = useRef(0);
  const slideUrlRef = useRef<string | null>(null);
  const liveRef = useRef<{ stream: MediaStream; ctx: AudioContext } | null>(null);

  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [slidePdf, setSlidePdf] = useState(false);
  const [hasSlide, setHasSlide] = useState(false);
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [pdfEpoch, setPdfEpoch] = useState(0);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [listening, setListening] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const textRef = useRef("");
  const interimRef = useRef("");
  const [sttNote, setSttNote] = useState<string | null>(null);
  const [slideNote, setSlideNote] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [probeResult, setProbeResult] = useState<{
    summary: string;
    points: { title: string; detail: string }[];
    received: { text: boolean; audio: string | null; slide: string | null };
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
      setPage(1);
      setPdfEpoch((n) => n + 1);
    } catch {
      if (slideGen.current !== gen) return;
      setSlideNote("PDF-г нээж чадсангүй.");
    }
  }

  useEffect(() => {
    let audioObject: string | null = null;
    let cancelled = false;

    (async () => {
      const [slide, audio] = await Promise.all([
        getFolderBlob(slideKey(folder.id)),
        getFolderBlob(audioKey(folder.id)),
      ]);
      if (cancelled) return;
      if (slide) await loadSlide(slide);
      else {
        setHasSlide(false);
        setSlidePdf(false);
        setPageCount(0);
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
      recRef.current?.stop();
      recRef.current = null;
      liveRef.current?.stream.getTracks().forEach((track) => track.stop());
      void liveRef.current?.ctx.close();
      liveRef.current = null;
    };
    // loadSlide closes over stable setters; reload only when the folder changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder.id]);

  useEffect(() => {
    const saved = loadSpeech(folder.id);
    textRef.current = saved ? `${saved} ` : "";
    setFinalText(textRef.current);
    interimRef.current = "";
    setInterim("");
  }, [folder.id]);

  useEffect(() => {
    if (!slidePdf) return;
    const doc = pdfRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    let cancelled = false;
    let task: { cancel: () => void } | null = null;

    const draw = async () => {
      const width = frameRef.current?.clientWidth || canvas.clientWidth || 960;
      try {
        const rendered = await paintPage(doc, page, canvas, width);
        task = rendered;
        if (cancelled) {
          rendered.cancel();
          return;
        }
        await rendered.promise;
      } catch (err) {
        if (!cancelled && !isCancel(err)) setSlideNote("Слайдыг зурж чадсангүй.");
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
  }, [page, pdfEpoch, slidePdf, full]);

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

  function releaseMic() {
    const live = liveRef.current;
    liveRef.current = null;
    live?.stream.getTracks().forEach((track) => track.stop());
    void live?.ctx.close();
    setAnalyser(null);
  }

  function writeSpeech(next: string) {
    const cleaned = next.replace(/\s+/g, " ").trim();
    textRef.current = cleaned ? `${cleaned} ` : "";
    saveSpeech(folder.id, cleaned);
    setFinalText(textRef.current);
  }

  function stopStt() {
    const pending = interimRef.current.trim();
    sttGen.current += 1;
    playingRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    releaseMic();
    setListening(false);
    interimRef.current = "";
    setInterim("");
    if (pending) writeSpeech(`${textRef.current} ${pending}`);
  }

  function beginStt() {
    stopStt();
    const mine = sttGen.current;
    playingRef.current = true;
    setListening(true);
    setSttNote(null);
    const ctx = new AudioContext();
    void ctx.resume();
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (sttGen.current !== mine) {
          stream.getTracks().forEach((track) => track.stop());
          void ctx.close();
          return;
        }
        const node = ctx.createAnalyser();
        node.fftSize = 2048;
        ctx.createMediaStreamSource(stream).connect(node);
        liveRef.current = { stream, ctx };
        setAnalyser(node);
      })
      .catch(() => {
        void ctx.close();
      });
    const rec = getRecognizer();
    if (!rec) {
      sttGen.current += 1;
      playingRef.current = false;
      setListening(false);
      setSttNote("Энэ хөтөч яриаг текст болгохгүй. Chrome дээр нээнэ үү.");
      return;
    }
    let interimTimer = 0;
    let startedAt = Date.now();
    rec.onresult = (ev) => {
      if (sttGen.current !== mine) return;
      let done = "";
      let live = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) done += piece + " ";
        else live += piece;
      }
      if (done) writeSpeech(`${textRef.current} ${done}`);
      interimRef.current = live;
      window.clearTimeout(interimTimer);
      interimTimer = window.setTimeout(() => {
        if (sttGen.current !== mine) return;
        setInterim(interimRef.current);
      }, 150);
    };
    rec.onerror = (ev) => {
      if (sttGen.current !== mine) return;
      if (ev.error === "not-allowed") {
        sttGen.current += 1;
        playingRef.current = false;
        setListening(false);
        releaseMic();
        setSttNote("Микрофон хаагдсан. Зөвшөөрсний дараа Ярих дээр дахин дар.");
      } else if (ev.error !== "aborted" && ev.error !== "no-speech") {
        setSttNote("Яриаг текст болгож чадсангүй.");
      }
    };
    rec.onend = () => {
      if (sttGen.current !== mine || !playingRef.current) return;
      // Chrome ends the recognizer immediately when the mic is busy, and restarting
      // it in a loop freezes the tab. Only continue after a real stretch of speech.
      if (Date.now() - startedAt < 2000) return;
      window.setTimeout(() => {
        if (sttGen.current !== mine || !playingRef.current) return;
        startedAt = Date.now();
        try {
          rec.start();
        } catch {
          /* already running */
        }
      }, 1200);
    };
    recRef.current = rec;
    try {
      rec.start();
    } catch {
      sttGen.current += 1;
      playingRef.current = false;
      setListening(false);
      releaseMic();
      setSttNote("Яриаг текст болгож эхлүүлж чадсангүй.");
    }
  }

  async function chooseSlide(file: File | undefined) {
    if (!file) return;
    await putFolderBlob(slideKey(folder.id), file);
    onChange({ ...folder, slideName: file.name });
    await loadSlide(file);
  }

  async function chooseAudio(file: File | undefined) {
    if (!file) return;
    await putFolderBlob(audioKey(folder.id), file);
    onChange({ ...folder, audioName: file.name });
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setTime(0);
  }

  function toggleSpeak() {
    if (playingRef.current) stopStt();
    else beginStt();
  }

  async function sendToModel() {
    const speech = `${textRef.current}${interimRef.current}`.trim();
    setProbing(true);
    setProbeNote(null);
    setProbeResult(null);
    try {
      const [audio, slide] = await Promise.all([
        getFolderBlob(audioKey(folder.id)),
        getFolderBlob(slideKey(folder.id)),
      ]);
      if (!USING_MOCK) {
        await sendToBackend(speech, audio, slide);
        return;
      }
      const slideText = pdfRef.current ? await readSlideText(pdfRef.current) : "";
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
      if (audio) body.set("audio", audio, folder.audioName ?? "audio");
      if (slide) body.set("slide", slide, folder.slideName ?? "slide");
      if (slideImage) body.set("slideImage", slideImage, "current-slide.jpg");
      const res = await fetch("/api/prototype", { method: "POST", body });
      const payload = (await res.json()) as {
        error?: string;
        summary?: string;
        points?: { title: string; detail: string }[];
        received?: { text: boolean; audio: string | null; slide: string | null };
      };
      if (!res.ok || !payload.summary || !payload.points || !payload.received) {
        setProbeNote(payload.error || "LLM рүү илгээж чадсангүй.");
        return;
      }
      setProbeResult({ summary: payload.summary, points: payload.points, received: payload.received });
    } catch (err) {
      const message =
        err instanceof ApiRequestError && err.code === "too_short"
          ? "Дуу 3 секундээс богино байна. Ахиад жаахан яриарай."
          : err instanceof ApiRequestError
            ? err.message
            : err instanceof Error
              ? err.message
              : "";
      setProbeNote(message || (USING_MOCK ? "LLM рүү илгээж чадсангүй." : "Backend рүү илгээж чадсангүй."));
    } finally {
      setProbing(false);
    }
  }

  async function sendToBackend(speech: string, audio: Blob | null, slide: Blob | null) {
    const audioFile = audio ? audioNameOf(audio, folder.audioName) : null;
    if (!audio || !audioFile) {
      setProbeNote("Дууны файл алга. Доорх Оруулах дээр дарж аудио нэмнэ үү.");
      return;
    }
    setProbeNote("Холбогдож байна…");
    const savedKey = `pitchcoach:backend-project:${folder.id}`;
    let projectId = localStorage.getItem(savedKey);
    if (projectId) {
      try {
        await api.getProject(projectId);
      } catch (err) {
        if (!(err instanceof ApiRequestError) || err.status !== 404) throw err;
        projectId = null;
      }
    }
    if (!projectId) {
      const project = await api.createProject({ name: folder.name || "Saylo" });
      projectId = project.id;
      localStorage.setItem(savedKey, projectId);
    }
    const attempt = await api.createAttempt(projectId);
    setProbeNote("Дуу илгээж байна…");
    await api.uploadAudio(attempt.id, audio, audioFile);
    const slidesFile = slide ? deckName(slide, folder.slideName) : null;
    if (slide && slidesFile) {
      const file = slide instanceof File ? slide : new File([slide], slidesFile, { type: slide.type || "application/pdf" });
      await api.uploadSlides(attempt.id, file);
    }
    if (speech) await api.setScript(attempt.id, speech);
    setProbeNote("Шинжилж байна…");
    await api.analyze(attempt.id);
    const report = await waitForReport(attempt.id);
    const points = report.feedback.recommendations
      .slice(0, 3)
      .map((item) => ({
        title: (item.problem || item.area).slice(0, 120),
        detail: (item.action || item.why).slice(0, 500),
      }))
      .filter((item) => item.title && item.detail);
    setProbeResult({
      summary: report.feedback.summary,
      points,
      received: { text: Boolean(speech), audio: audioFile, slide: slidesFile },
    });
    const notes = [...report.notes];
    if (slide && !slidesFile) notes.push("Слайд PDF эсвэл PPTX байх ёстой.");
    if (notes.length) setProbeNote(notes.join(" "));
  }

  function toggleAudio() {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      beginStt();
      void el.play();
    } else {
      el.pause();
      stopStt();
    }
  }

  const spoken = `${finalText}${interim}`.trim();
  function speakButton() {
    return (
      <button type="button" className={listening ? "desk-ghost" : "desk-primary"} onClick={toggleSpeak}>
        {listening && <span className="desk-rec" aria-hidden />}
        {listening ? "Зогсоох" : "Ярих"}
      </button>
    );
  }
  function pageButtons() {
    if (pageCount < 2) return null;
    return (
      <>
        <button type="button" className="desk-ghost" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>
          Өмнөх
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
          Дараах
        </button>
      </>
    );
  }

  return (
    <div className="desk">
      <div className="desk-col">
        <div className="desk-bar">
          <WaveMark />
          <span>Pitch Coach</span>
        </div>
        <div className="desk-title">
          <div>
            <button type="button" className="desk-back" onClick={onBack}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path d="M8.5 2.5 4 7l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Хавтаснууд
            </button>
            <h1>{folder.name}</h1>
            <p className="desk-sub">{pageCount > 1 ? `Слайд ${page} / ${pageCount}` : "Ярь. Текст баруун талд бичигдэнэ."}</p>
          </div>
        </div>
        <div className="desk-actions" hidden={full && hasSlide}>
          {speakButton()}
          {hasSlide && (
            <button type="button" className="desk-ghost" onClick={() => setFull(true)}>
              Бүтэн дэлгэц
            </button>
          )}
        </div>

        <div className="desk-stage">
          <div>
            <div className={full && hasSlide ? "desk-full" : undefined}>
              {slidePdf ? (
                <div ref={frameRef} className="desk-slide">
                  <canvas ref={canvasRef} width={1920} height={1080} />
                </div>
              ) : slideUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="desk-slide" src={slideUrl} alt={folder.slideName ?? "Figma слайд"} />
              ) : (
                <label className="desk-slide-empty">
                  <span>Figma слайд</span>
                  Зураг оруулах
                  <input
                    type="file"
                    accept="image/*,.pdf"
                    className="sr-only"
                    onChange={(e) => chooseSlide(e.target.files?.[0])}
                  />
                </label>
              )}
              {full && hasSlide && (
                <div className="desk-full-bar">
                  {speakButton()}
                  {pageButtons()}
                  <button type="button" className="desk-ghost" onClick={() => setFull(false)}>
                    Хаах
                  </button>
                </div>
              )}
            </div>
            {hasSlide && !full && (
              <div className="desk-tools">
                <div className="desk-pages">{pageButtons()}</div>
                <label className="desk-link">
                  Слайд солих
                  <input type="file" accept="image/*,.pdf" className="sr-only" onChange={(e) => chooseSlide(e.target.files?.[0])} />
                </label>
              </div>
            )}
            {slideNote && <p className="desk-note">{slideNote}</p>}
          </div>
          <aside className="desk-speech">
            <h2>Ярианы текст</h2>
            <p className="desk-sub">
              {listening ? "Сонсож байна" : spoken ? "Яриа хадгалагдсан" : "Ярих дээр дараад ярь"}
            </p>
            <p>
              {spoken || <span className="desk-missing">Хоосон</span>}
            </p>
            {sttNote && <p className="desk-note">{sttNote}</p>}
            <div className="desk-probe">
              <button
                type="button"
                className="desk-ghost"
                disabled={probing || (!spoken && !folder.audioName && !hasSlide)}
                onClick={() => void sendToModel()}
              >
                {probing ? "Илгээж байна" : USING_MOCK ? "LLM рүү илгээх" : "Backend рүү илгээх"}
              </button>
              {probeNote && <p className="desk-note">{probeNote}</p>}
              {probeResult && (
                <>
                  <p>
                    {probeResult.received.text ? "Текст" : "Текст алга"}
                    {probeResult.received.audio ? ` · Аудио ${probeResult.received.audio}` : ""}
                    {probeResult.received.slide ? ` · Слайд ${probeResult.received.slide}` : ""}
                  </p>
                  <h3>{probeResult.summary}</h3>
                  {probeResult.points.length > 0 && (
                    <ul>
                      {probeResult.points.map((point) => (
                        <li key={point.title}>
                          <strong>{point.title}</strong>
                          {point.detail}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}
            </div>
          </aside>
        </div>

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
        <audio
          ref={audioRef}
          src={audioUrl ?? undefined}
          preload="metadata"
          className="hidden"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => stopStt()}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />
        </div>
      </div>
    </div>
  );
}

function WaveMark() {
  return (
    <svg width="22" height="14" viewBox="0 0 22 14" aria-hidden>
      <path
        d="M1 7h2l2-5 3 10 3-8 2 3h8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
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
    <div className="mt-[14px] overflow-hidden rounded-[20px] bg-white text-[#111]">
      <button type="button" onClick={url && !live ? onToggle : undefined} className="relative block w-full px-4 pb-4 pt-6 text-left" disabled={!url || Boolean(live)}>
        <svg viewBox="0 0 640 160" className="h-36 w-full" aria-hidden>
          <path d={d} fill="none" stroke="#c5d7fb" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
          <path
            d={d}
            fill="none"
            stroke="#5b8def"
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
            clipPath={`url(#${clipId})`}
          />
          <clipPath id={clipId}>
            <rect width={640 * progress} height="160" />
          </clipPath>
        </svg>
        <span className="absolute bottom-4 left-4 flex h-8 w-8 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-700">
          {playing ? <span className="h-2.5 w-2.5 rounded-sm bg-zinc-700" /> : <PlayMark />}
        </span>
      </button>
      <div className="flex items-center justify-between gap-3 border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500">
        <span className="truncate">{name ?? "Аудио"}</span>
        <span className="shrink-0 tabular-nums">
          {live ? "Сонсож байна" : url ? `${formatClock(time)} / ${formatClock(duration)}` : "Файл оруулаагүй"}
        </span>
        <label className="shrink-0 cursor-pointer underline">
          {url ? "Солих" : "Оруулах"}
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
