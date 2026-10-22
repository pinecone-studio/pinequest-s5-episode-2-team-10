"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  audioKey,
  getFolderBlob,
  loadFolders,
  putFolderBlob,
  saveFolders,
  slideKey,
  type FolderMeta,
} from "@/lib/folderStore";

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

  const [slideUrl, setSlideUrl] = useState<string | null>(null);
  const [slidePdf, setSlidePdf] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [listening, setListening] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [finalText, setFinalText] = useState("");
  const [interim, setInterim] = useState("");
  const [sttNote, setSttNote] = useState<string | null>(null);

  useEffect(() => {
    let slideObject: string | null = null;
    let audioObject: string | null = null;
    let cancelled = false;

    (async () => {
      const [slide, audio] = await Promise.all([
        getFolderBlob(slideKey(folder.id)),
        getFolderBlob(audioKey(folder.id)),
      ]);
      if (cancelled) return;
      if (slide) {
        slideObject = URL.createObjectURL(slide);
        setSlideUrl(slideObject);
        setSlidePdf(slide.type === "application/pdf" || (folder.slideName ?? "").toLowerCase().endsWith(".pdf"));
      } else {
        setSlideUrl(null);
        setSlidePdf(false);
      }
      if (audio) {
        audioObject = URL.createObjectURL(audio);
        setAudioUrl(audioObject);
      } else setAudioUrl(null);
    })();

    return () => {
      cancelled = true;
      if (slideObject) URL.revokeObjectURL(slideObject);
      if (audioObject) URL.revokeObjectURL(audioObject);
      recRef.current?.stop();
      recRef.current = null;
    };
  }, [folder.id]);

  function stopStt() {
    sttGen.current += 1;
    playingRef.current = false;
    recRef.current?.stop();
    recRef.current = null;
    setListening(false);
    setInterim("");
  }

  function beginStt() {
    stopStt();
    const mine = sttGen.current;
    playingRef.current = true;
    setListening(true);
    setSttNote(null);
    const rec = getRecognizer();
    if (!rec) {
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
        playingRef.current = false;
        setListening(false);
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
      playingRef.current = false;
      setListening(false);
      setSttNote("Яриаг текст болгож эхлүүлж чадсангүй.");
    }
  }

  async function chooseSlide(file: File | undefined) {
    if (!file) return;
    await putFolderBlob(slideKey(folder.id), file);
    onChange({ ...folder, slideName: file.name });
    setSlidePdf(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf"));
    setSlideUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
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
    <main className="mx-auto w-full max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center gap-3">
        <button type="button" onClick={onBack} className="text-sm text-zinc-500 underline">
          ← Хавтаснууд
        </button>
        <h1 className="text-xl font-semibold">{folder.name}</h1>
      </div>

      <div className="grid items-start gap-4 min-[680px]:grid-cols-[minmax(0,1.6fr)_minmax(14rem,0.8fr)]">
        <div className="space-y-3">
          {slideUrl && slidePdf ? (
            <iframe title={folder.slideName ?? "Figma слайд"} src={slideUrl} className="aspect-video w-full rounded-xl border border-zinc-200 bg-white dark:border-zinc-800" />
          ) : slideUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={slideUrl} alt={folder.slideName ?? "Figma слайд"} className="max-h-[28rem] w-full rounded-xl border border-zinc-200 object-contain dark:border-zinc-800" />
          ) : (
            <label className="flex aspect-video cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-zinc-300 text-sm text-zinc-500 dark:border-zinc-700">
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
          {slideUrl && (
            <label className="inline-block cursor-pointer text-xs text-zinc-500 underline">
              Слайд солих
              <input type="file" accept="image/*" className="sr-only" onChange={(e) => chooseSlide(e.target.files?.[0])} />
            </label>
          )}

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
                {listening ? "Сонсож байна. Ярихад баруун талд бичигдэнэ." : "Файл хэрэггүй. Дарж ярь."}
              </span>
            </span>
          </button>

          {audioUrl ? (
            <button
              type="button"
              onClick={toggleAudio}
              className="flex w-full items-center gap-3 rounded-xl border border-zinc-200 px-3 py-3 text-left hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              <span
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white ${
                  playing ? "bg-red-600" : "bg-zinc-900 dark:bg-zinc-100 dark:text-zinc-900"
                }`}
                aria-hidden
              >
                {playing ? <span className="h-3 w-3 rounded-sm bg-white" /> : <PlayMark />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{folder.audioName ?? "Аудио"}</span>
                <span className="mt-1 block h-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
                  <span
                    className="block h-full bg-zinc-900 dark:bg-zinc-100"
                    style={{ width: duration ? `${Math.min(100, (time / duration) * 100)}%` : "0%" }}
                  />
                </span>
              </span>
              <span className="shrink-0 text-xs tabular-nums text-zinc-500">
                {formatClock(time)} / {formatClock(duration)}
              </span>
            </button>
          ) : (
            <label className="flex cursor-pointer items-center justify-between rounded-xl border border-dashed border-zinc-300 px-4 py-4 text-sm dark:border-zinc-700">
              <span>
                <span className="block font-medium">Аудио</span>
                <span className="text-zinc-500">Файл оруулаад дарж эхлүүлнэ</span>
              </span>
              <span className="text-zinc-500 underline">Оруулах</span>
              <input
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
                className="sr-only"
                onChange={(e) => chooseAudio(e.target.files?.[0])}
              />
            </label>
          )}
          {audioUrl && (
            <label className="inline-block cursor-pointer text-xs text-zinc-500 underline">
              Аудио солих
              <input
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.webm,.ogg"
                className="sr-only"
                onChange={(e) => chooseAudio(e.target.files?.[0])}
              />
            </label>
          )}
          <audio
            ref={audioRef}
            src={audioUrl ?? undefined}
            preload="metadata"
            className="hidden"
            onPlay={() => setPlaying(true)}
            onPause={() => {
              setPlaying(false);
              stopStt();
            }}
            onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
            onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
          />
        </div>

        <aside className="min-h-64 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
          <h2 className="text-sm font-medium">Ярианы текст</h2>
          <p className="mt-1 text-xs text-zinc-500">
            {listening ? "Сонсож байна" : "Ярих дээр дараад ярь"}
          </p>
          <p className="mt-4 whitespace-pre-wrap text-sm leading-relaxed">
            {spoken || <span className="text-zinc-400">Хоосон</span>}
          </p>
          {sttNote && <p className="mt-3 text-sm text-red-600">{sttNote}</p>}
        </aside>
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

function PlayMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="ml-0.5">
      <path fill="currentColor" d="M4 2.2v9.6l8-4.8-8-4.8Z" />
    </svg>
  );
}
