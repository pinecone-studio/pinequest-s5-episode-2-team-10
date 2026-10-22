"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import {
  audioKey,
  getFolderBlob,
  loadFolders,
  putFolderBlob,
  saveFolders,
  slideKey,
  type FolderMeta,
} from "@/lib/folderStore";
import { openPdf, paintPage } from "@/lib/slidePdf";

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

  if (!ready) return <main className="mx-auto w-full max-w-5xl px-4 py-10" />;

  if (!open) {
    return (
      <main className="mx-auto w-full max-w-3xl px-4 py-10">
        <header className="mb-8 flex items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Хавтаснууд</h1>
            <p className="mt-1 text-sm text-zinc-500">Figma слайд, аудио, ярианы текст нэг дор.</p>
          </div>
          <Link href="/" className="text-sm text-zinc-500 underline">
            Төслүүд
          </Link>
        </header>

        {naming ? (
          <form onSubmit={createFolder} className="mb-6 space-y-3 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
            <label className="block space-y-1 text-sm">
              <span>Хавтасны нэр</span>
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="figma tdd"
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 outline-none focus:border-zinc-900 dark:border-zinc-700 dark:focus:border-zinc-100"
              />
            </label>
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm dark:border-zinc-700">
              <span>
                <span className="block font-medium">Слайд</span>
                <span className="text-zinc-500">{slideFile ? slideFile.name : "TDD слайдаа оруул"}</span>
              </span>
              <span className="text-zinc-500 underline">{slideFile ? "Солих" : "Оруулах"}</span>
              <input
                type="file"
                accept="image/*,.pdf"
                className="sr-only"
                onChange={(e) => setSlideFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <button
              type="submit"
              disabled={!draft.trim() || !slideFile}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
            >
              Үүсгээд орох
            </button>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setNaming(true)}
            className="mb-6 rounded-lg border border-dashed border-zinc-300 px-4 py-3 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Хавтас нэмэх
          </button>
        )}

        <ul className="grid gap-3 sm:grid-cols-2">
          {folders.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                onClick={() => setOpenId(folder.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 px-4 py-4 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
              >
                <FolderMark />
                <span className="font-medium">{folder.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </main>
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
  const [sttNote, setSttNote] = useState<string | null>(null);
  const [slideNote, setSlideNote] = useState<string | null>(null);

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
  }, [page, pdfEpoch, slidePdf]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
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

  function stopStt() {
    sttGen.current += 1;
    playingRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    releaseMic();
    setListening(false);
    setInterim("");
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
    rec.onresult = (ev) => {
      if (sttGen.current !== mine) return;
      let done = "";
      let live = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const piece = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) done += piece + " ";
        else live += piece;
      }
      if (done) setFinalText((prev) => (prev + done).replace(/\s+/g, " ").trim() + " ");
      setInterim(live);
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
      try {
        rec.start();
      } catch {
        /* already running */
      }
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
    setFinalText("");
    setInterim("");
  }

  function toggleSpeak() {
    if (playingRef.current) stopStt();
    else beginStt();
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

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <button type="button" onClick={onBack} className="text-sm text-zinc-500 underline">
          ← Хавтаснууд
        </button>
        <h1 className="text-xl font-semibold">{folder.name}</h1>
      </div>

      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div>
          {slidePdf ? (
            <div ref={frameRef} className="overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800">
              <canvas ref={canvasRef} width={1920} height={1080} className="block h-auto w-full bg-white" />
            </div>
          ) : slideUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={slideUrl} alt={folder.slideName ?? "Figma слайд"} className="max-h-[36rem] w-full rounded-xl border border-zinc-200 bg-zinc-50 object-contain dark:border-zinc-800 dark:bg-zinc-900" />
          ) : (
            <label className="flex min-h-80 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700">
              <span className="font-medium text-zinc-800 dark:text-zinc-200">Figma слайд</span>
              Зураг оруулах
              <input
                type="file"
                accept="image/*,.pdf"
                className="sr-only"
                onChange={(e) => chooseSlide(e.target.files?.[0])}
              />
            </label>
          )}
          {hasSlide && (
            <div className="mt-3 flex items-center justify-between gap-3">
              {pageCount > 1 ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((current) => Math.max(1, current - 1))}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
                  >
                    Өмнөх
                  </button>
                  <span className="min-w-16 text-center text-sm tabular-nums">
                    {page} / {pageCount}
                  </span>
                  <button
                    type="button"
                    disabled={page >= pageCount}
                    onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                    className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm disabled:opacity-40 dark:border-zinc-700"
                  >
                    Дараах
                  </button>
                </div>
              ) : (
                <span />
              )}
              <label className="cursor-pointer text-xs text-zinc-500 underline">
                Слайд солих
                <input type="file" accept="image/*,.pdf" className="sr-only" onChange={(e) => chooseSlide(e.target.files?.[0])} />
              </label>
            </div>
          )}
          {slideNote && <p className="mt-2 text-sm text-red-600">{slideNote}</p>}
        </div>
        <aside className="flex min-h-64 flex-col overflow-y-auto rounded-xl border border-zinc-200 p-4 lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] dark:border-zinc-800">
          <h2 className="text-sm font-medium">Ярианы текст</h2>
          <p className="mt-1 text-xs text-zinc-500">{listening ? "Сонсож байна" : "Ярих дээр дараад ярь"}</p>
          <p className="mt-4 flex-1 whitespace-pre-wrap text-sm leading-relaxed">
            {spoken || <span className="text-zinc-400">Хоосон</span>}
          </p>
          {sttNote && <p className="mt-3 text-sm text-red-600">{sttNote}</p>}
        </aside>
      </div>

      <div className="mt-4 space-y-3">

          <button
            type="button"
            onClick={toggleSpeak}
            className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white ${
                listening ? "bg-red-600" : "bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900"
              }`}
              aria-hidden
            >
              {listening ? <span className="h-3 w-3 rounded-sm bg-white" /> : <span className="h-3.5 w-3.5 rounded-full bg-red-500" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{listening ? "Зогсоох" : "Ярих"}</span>
              <span className="text-xs text-zinc-500">
                {listening ? "Сонсож байна. Долгион хөдөлж, текст баруун талд бичигдэнэ." : "Файл хэрэггүй. Дарж ярь."}
              </span>
            </span>
          </button>

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
    </main>
  );
}

function FolderMark() {
  return (
    <svg width="22" height="18" viewBox="0 0 22 18" aria-hidden className="shrink-0 text-zinc-500">
      <path
        fill="currentColor"
        d="M1 3.5A2.5 2.5 0 0 1 3.5 1H8l2 2h8.5A2.5 2.5 0 0 1 21 5.5v9a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 1 14.5v-11Z"
      />
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
  const count = 96;
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
      if (now - last < 70) return;
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
    <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white text-zinc-900">
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
