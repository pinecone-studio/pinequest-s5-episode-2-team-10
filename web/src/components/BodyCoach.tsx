"use client";

// Body-language prototype: MediaPipe face and pose landmarks, in the browser. The video stays on
// this computer and isn't saved; only the per-frame measurements are kept until the page closes.

import { useEffect, useRef, useState } from "react";
import type { DrawingUtils, FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  blendshapeMap,
  faceSignals,
  poseSignals,
  recent,
  summarize,
  type EyeState,
  type FrameSignals,
  type HandState,
  type Summary,
  type Tip,
} from "@/lib/bodySignals";
import { useLang } from "@/lib/i18nClient";

const VERSION = "1.0.1"; // keep in step with package.json (and PoseCoach)
const WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}/wasm`;
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const FRAME_MS = 66; // ~15 analyses per second is plenty and keeps the laptop cool
const LIVE_MS = 500;

const TEXT = {
  mn: {
    title: "Биеийн хэл ба харц (туршилт)",
    panelTitle: "Биеийн хэл ба харц",
    panelHint: "«Ярих»-ыг дарахад хэмжиж эхэлнэ, зогсоход дүгнэлт гарна. Видео энэ компьютерээс гарахгүй.",
    panelSummary: "Энэ бичлэгийн биеийн хэл",
    intro:
      "Камер таны нүүр, мөр, гарыг таньж харц, гарын хөдөлгөөн, биеийн байрлалыг хэмжинэ. Видео энэ компьютерээс гарахгүй, хадгалагдахгүй.",
    camera: "Камер асаах",
    loading: "Загвар ачаалж байна…",
    record: "Дасгал эхлэх",
    finish: "Дуусгах",
    again: "Дахин дасгал хийх",
    cameraOff: "Камер унтраах",
    denied: "Камер ашиглах зөвшөөрөл өгөөгүй эсвэл камер олдсонгүй.",
    loadFail: "Загвар ачаалж чадсангүй. Интернэт холболтоо шалгана уу.",
    eyeContact: "Харц (камер руу)",
    hands: "Гар харагдаж байна",
    shoulders: "Мөрний хазайлт",
    noFace: "Нүүр харагдахгүй байна",
    noBody: "Мөр харагдахгүй байна: камераас жаахан холдоорой",
    recording: "Бичиж байна",
    seconds: "Хугацаа",
    lookingDown: "Доош харсан",
    handsActive: "Гарын хөдөлгөөнтэй",
    handsStill: "Гар хөдөлгөөнгүй",
    swaying: "Ганхсан",
    tilted: "Мөр хазайсан",
    eyesRow: "Харц",
    handsRow: "Гар",
    tipsTitle: "Дараагийн удаа",
    noTips: "Сайн байна. Харц, гар, байрлал бүгд хэвийн хэмжээнд байна.",
    disclaimer: "Камерын тооцоолол. Сэтгэл хөдлөл, өөртөө итгэлийг дүгнэдэггүй.",
    contact: "Харцтай",
    away: "Өөр тийш",
    down: "Доош",
    none: "Харагдахгүй",
    active: "Хөдөлгөөнтэй",
    still: "Хөдөлгөөнгүй",
    wild: "Хэт их",
    hidden: "Харагдахгүй",
  },
  en: {
    title: "Body language and eye contact (prototype)",
    panelTitle: "Body language and eye contact",
    panelHint: "Measuring starts when you press Speak, and the summary shows when you stop. The video never leaves this computer.",
    panelSummary: "Body language in this take",
    intro:
      "The camera finds your face, shoulders and hands, and measures eye contact, gestures and posture. The video never leaves this computer and isn't saved.",
    camera: "Turn on camera",
    loading: "Loading models…",
    record: "Start practice",
    finish: "Finish",
    again: "Practice again",
    cameraOff: "Turn off camera",
    denied: "Camera permission was denied, or no camera was found.",
    loadFail: "Couldn't load the models. Check the internet connection.",
    eyeContact: "Eye contact (camera)",
    hands: "Hands visible",
    shoulders: "Shoulder tilt",
    noFace: "No face in view",
    noBody: "Shoulders not in view: move back a little",
    recording: "Recording",
    seconds: "Length",
    lookingDown: "Looked down",
    handsActive: "Hands moving",
    handsStill: "Hands still",
    swaying: "Swaying",
    tilted: "Shoulders tilted",
    eyesRow: "Eyes",
    handsRow: "Hands",
    tipsTitle: "Next time",
    noTips: "Good: eye contact, hands and posture are all within normal ranges.",
    disclaimer: "Estimates from the camera. It doesn't judge emotions or confidence.",
    contact: "Eye contact",
    away: "Looking away",
    down: "Looking down",
    none: "Not seen",
    active: "Moving",
    still: "Still",
    wild: "A lot",
    hidden: "Not seen",
  },
} as const;

const TIPS: Record<"mn" | "en", Record<Tip, string>> = {
  mn: {
    eyeContact: "Сонсогч руу (камер руу) илүү их хар. Өгүүлбэр бүрийн төгсгөлд камер руу харж дуусга.",
    lookingDown: "Тэмдэглэлээ бага хар: гол санаануудаа цээжилж, зөвхөн хэсэг шилжихэд хар.",
    handsHidden: "Гараа бүсээс дээш, харагдахаар байлга. Гараараа санаагаа илэрхийлэх нь сонсогчид ойлгомжтой.",
    handsStill: "Гол санаа, тоо дээрээ гараараа онцлох хөдөлгөөн нэм.",
    handsWild: "Гарын хөдөлгөөнөө цөөлж, зөвхөн гол санаан дээр ашигла.",
    swaying: "Хоёр хөлөө тогтвортой тавьж, хажуу тийш ганхахаас зайлсхий.",
    tilted: "Мөрөө тэгш, нуруугаа шулуун байлга.",
    far: "Камер руу ойртож, мөр, гар хоёулаа харагдахаар зогс.",
    near: "Камераас жаахан холдож, гар харагдахаар зогс.",
    noFace: "Нүүр тань ихэнх хугацаанд харагдсангүй. Камерын өмнө зогсоод дахин оролдоорой.",
  },
  en: {
    eyeContact: "Look at the audience (the camera) more. Finish each sentence looking at the camera.",
    lookingDown: "Look at your notes less: learn the main points and glance down only between sections.",
    handsHidden: "Keep your hands above the waist and in view. Gestures make ideas easier to follow.",
    handsStill: "Add a gesture on your main points and numbers.",
    handsWild: "Gesture less, and save it for the main points.",
    swaying: "Plant both feet and avoid swaying side to side.",
    tilted: "Keep your shoulders level and your back straight.",
    far: "Move closer so your shoulders and hands are both in view.",
    near: "Step back a little so your hands are in view.",
    noFace: "Your face wasn't in view most of the time. Stand in front of the camera and try again.",
  },
};

const EYE_COLOR: Record<EyeState, string> = { contact: "#3fb950", away: "#f85149", down: "#d29922", none: "#484f58" };
const HAND_COLOR: Record<HandState, string> = { active: "#3fb950", still: "#d29922", wild: "#f85149", hidden: "#484f58" };

type Phase = "idle" | "loading" | "live" | "recording" | "done";
type Live = ReturnType<typeof recent> & { face: boolean; body: boolean };

interface Models {
  pose: PoseLandmarker;
  face: FaceLandmarker;
  draw: DrawingUtils;
  connections: { start: number; end: number }[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The camera and the face and pose models: preview, live meters, and recording a practice into a
 * summary. Used by the /dev/body page and by the pitch page's body-language card.
 */
function useBodyTracker(errors: { denied: string; loadFail: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const models = useRef<Models | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const raf = useRef(0);
  const frames = useRef<FrameSignals[]>([]); // the practice being recorded
  const recentFrames = useRef<FrameSignals[]>([]); // the last few seconds, for the live meters
  const recording = useRef(false);
  const started = useRef(0);

  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);

  function stopCamera() {
    cancelAnimationFrame(raf.current);
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    models.current?.pose.close();
    models.current?.face.close();
    models.current = null;
    recording.current = false;
  }

  useEffect(() => stopCamera, []);

  async function start() {
    setError(null);
    setPhase("loading");
    const video = videoRef.current;
    if (!video) return;
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { width: 1280, height: 720, facingMode: "user" },
        audio: false,
      });
      video.srcObject = stream.current;
      await video.play();
    } catch {
      stopCamera();
      setError(errors.denied);
      setPhase("idle");
      return;
    }
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const files = await vision.FilesetResolver.forVisionTasks(WASM);
      const make = (delegate: "GPU" | "CPU") =>
        Promise.all([
          vision.PoseLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: POSE_MODEL, delegate },
            runningMode: "VIDEO",
            numPoses: 1,
          }),
          vision.FaceLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: FACE_MODEL, delegate },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
          }),
        ]);
      let pose: PoseLandmarker, face: FaceLandmarker;
      try {
        [pose, face] = await make("GPU");
      } catch {
        [pose, face] = await make("CPU"); // no WebGL: slower, still works
      }
      const ctx = canvasRef.current!.getContext("2d")!;
      models.current = { pose, face, draw: new vision.DrawingUtils(ctx), connections: vision.PoseLandmarker.POSE_CONNECTIONS };
    } catch {
      stopCamera();
      setError(errors.loadFail);
      setPhase("idle");
      return;
    }
    if (!stream.current) return; // turned off while the models loaded
    started.current = 0; // set from the first animation frame's timestamp
    setPhase("live");
    let last = 0;
    let lastLive = 0;
    const tick = (now: number) => {
      raf.current = requestAnimationFrame(tick);
      if (!started.current) started.current = now;
      if (now - last < FRAME_MS || video.readyState < 2 || !models.current) return;
      last = now;
      const frame = analyse(video, now);
      recentFrames.current.push(frame);
      recentFrames.current = recentFrames.current.filter((f) => f.t > frame.t - 6);
      if (recording.current) frames.current.push(frame);
      if (now - lastLive > LIVE_MS) {
        lastLive = now;
        setLive({ ...recent(recentFrames.current), face: frame.face, body: frame.body });
        if (recording.current && frames.current.length) setElapsed(frame.t - frames.current[0].t);
      }
    };
    raf.current = requestAnimationFrame(tick);
  }

  function analyse(video: HTMLVideoElement, now: number): FrameSignals {
    const m = models.current!;
    const pose = m.pose.detectForVideo(video, now);
    const face = m.face.detectForVideo(video, now);
    const aspect = video.videoWidth / Math.max(1, video.videoHeight);
    const landmarks = pose.landmarks?.[0];
    const hasFace = !!face.faceLandmarks?.length;
    const facial = hasFace
      ? faceSignals(blendshapeMap(face.faceBlendshapes?.[0]?.categories), face.facialTransformationMatrixes?.[0]?.data ?? null)
      : { eyeContact: false, lookingDown: false, yaw: null, pitch: null };
    const frame: FrameSignals = {
      t: (now - started.current) / 1000,
      face: hasFace,
      ...facial,
      ...poseSignals(landmarks, aspect),
    };

    // Overlay: the skeleton, and a box around the face coloured by where the eyes point.
    const canvas = canvasRef.current!;
    if (canvas.width !== video.videoWidth) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (landmarks) {
      m.draw.drawConnectors(landmarks, m.connections, { color: "rgba(255,255,255,0.7)", lineWidth: 3 });
      m.draw.drawLandmarks(landmarks, { color: "#58a6ff", radius: 3 });
    }
    const points = face.faceLandmarks?.[0];
    if (points) {
      const xs = points.map((p) => p.x * canvas.width);
      const ys = points.map((p) => p.y * canvas.height);
      ctx.strokeStyle = EYE_COLOR[frame.lookingDown ? "down" : frame.eyeContact ? "contact" : "away"];
      ctx.lineWidth = 4;
      ctx.strokeRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
    return frame;
  }

  function record() {
    frames.current = [];
    setElapsed(0);
    setSummary(null);
    recording.current = true;
    setPhase("recording");
  }

  function finish() {
    recording.current = false;
    // Development only: lets tests and tuning read the raw measurements.
    if (process.env.NODE_ENV === "development") (globalThis as { __bodyFrames?: FrameSignals[] }).__bodyFrames = frames.current;
    setSummary(summarize(frames.current));
    setPhase("done");
  }

  function turnOff() {
    stopCamera();
    setLive(null);
    setPhase("idle");
  }

  return { videoRef, canvasRef, phase, error, live, elapsed, summary, start, record, finish, turnOff };
}

/** The camera preview with the overlay, mirrored like a mirror. */
function Preview({ tracker, tx }: { tracker: ReturnType<typeof useBodyTracker>; tx: (typeof TEXT)["mn" | "en"] }) {
  const { videoRef, canvasRef, phase, elapsed } = tracker;
  const cameraOn = phase === "live" || phase === "recording" || phase === "done";
  return (
    <div className="relative overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: "16 / 9" }}>
      <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full object-cover" style={{ transform: "scaleX(-1)" }} />
      {phase === "recording" && (
        <span className="absolute left-3 top-3 rounded-full bg-red-600 px-3 py-1 text-xs font-medium text-white">
          ● {tx.recording} {Math.floor(elapsed)}s
        </span>
      )}
      {!cameraOn && (
        <div className="absolute inset-0 flex items-center justify-center text-sm opacity-70">{phase === "loading" ? tx.loading : ""}</div>
      )}
    </div>
  );
}

function LiveMeters({ live, tx }: { live: Live; tx: (typeof TEXT)["mn" | "en"] }) {
  return (
    <div className="space-y-3" aria-live="polite">
      {!live.face && <p className="text-sm text-amber-400">{tx.noFace}</p>}
      {!live.body && <p className="text-sm text-amber-400">{tx.noBody}</p>}
      <Meter label={tx.eyeContact} value={live.eyeContact} good={0.6} />
      <Meter label={tx.hands} value={live.handsVisible} good={0.4} />
      <div className="flex justify-between text-sm">
        <span>{tx.shoulders}</span>
        <span className="tabular-nums">{live.tilt === null ? "–" : `${Math.round(live.tilt)}°`}</span>
      </div>
    </div>
  );
}

function SummaryView({ summary, tx, lang }: { summary: Summary; tx: (typeof TEXT)["mn" | "en"]; lang: "mn" | "en" }) {
  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label={tx.seconds} value={`${summary.seconds} s`} />
        <Stat label={tx.eyeContact} value={pct(summary.eyeContact)} />
        <Stat label={tx.lookingDown} value={pct(summary.lookingDown)} />
        <Stat label={tx.hands} value={pct(summary.handsVisible)} />
        <Stat label={tx.handsActive} value={pct(summary.handsActive)} />
        <Stat label={tx.handsStill} value={pct(summary.handsStill)} />
        <Stat label={tx.swaying} value={pct(summary.swaying)} />
        <Stat label={tx.tilted} value={pct(summary.tilted)} />
      </dl>

      {summary.timeline.length > 0 && (
        <div className="space-y-2 text-xs">
          <Strip label={tx.eyesRow} cells={summary.timeline.map((s) => EYE_COLOR[s.eyes])} />
          <Strip label={tx.handsRow} cells={summary.timeline.map((s) => HAND_COLOR[s.hands])} />
          <div className="flex flex-wrap gap-3 opacity-70">
            {(["contact", "away", "down", "none"] as const).map((k) => (
              <Legend key={k} color={EYE_COLOR[k]} label={tx[k]} />
            ))}
            {(["active", "still", "wild"] as const).map((k) => (
              <Legend key={k} color={HAND_COLOR[k]} label={`${tx.handsRow}: ${tx[k]}`} />
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-2 font-medium">{tx.tipsTitle}</h3>
        {summary.tips.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {summary.tips.map((tip) => (
              <li key={tip}>{TIPS[lang][tip]}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">{tx.noTips}</p>
        )}
      </div>
      <p className="text-xs opacity-60">{tx.disclaimer}</p>
    </div>
  );
}

/** The /dev/body prototype page: camera, practice and summary on their own. */
export default function BodyCoach() {
  const { lang } = useLang();
  const tx = TEXT[lang];
  const tracker = useBodyTracker({ denied: tx.denied, loadFail: tx.loadFail });
  const { phase, error, live, summary, start, record, finish, turnOff } = tracker;
  const cameraOn = phase === "live" || phase === "recording" || phase === "done";

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold">{tx.title}</h1>
      <p className="mt-1 max-w-3xl text-sm opacity-70">{tx.intro}</p>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <Preview tracker={tracker} tx={tx} />
          <div className="mt-4 flex flex-wrap gap-3">
            {phase === "idle" && (
              <button type="button" className="desk-primary" onClick={start}>
                {tx.camera}
              </button>
            )}
            {(phase === "live" || phase === "done") && (
              <button type="button" className="desk-primary" onClick={record}>
                {phase === "done" ? tx.again : tx.record}
              </button>
            )}
            {phase === "recording" && (
              <button type="button" className="desk-primary" onClick={finish}>
                {tx.finish}
              </button>
            )}
            {cameraOn && (
              <button type="button" className="desk-ghost" onClick={turnOff}>
                {tx.cameraOff}
              </button>
            )}
          </div>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
        </div>

        <aside className="space-y-4">
          {live && (
            <div className="rounded-2xl border border-white/10 p-4">
              <LiveMeters live={live} tx={tx} />
            </div>
          )}
          {summary && (
            <div className="rounded-2xl border border-white/10 p-4">
              <SummaryView summary={summary} tx={tx} lang={lang} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The pitch page's body-language card: live meters while the camera window watches, and the take's
 * summary after the speaker stops. The camera, its preview and the lines are in the camera window
 * over the slide (PoseCoach), shared with the slide gestures.
 */
export function BodyCoachPanel({ live, summary, speaking }: { live: Live | null; summary: Summary | null; speaking: boolean }) {
  const { lang } = useLang();
  const tx = TEXT[lang];
  return (
    <section className="room-card body-panel" aria-label={tx.panelTitle}>
      <div className="section-head">
        <div>
          <h2>{tx.panelTitle}</h2>
          <p className="desk-sub">{tx.panelHint}</p>
        </div>
        {speaking && <span className="body-panel-rec">● {tx.recording}</span>}
      </div>
      <div className="body-panel-live">
        {live ? <LiveMeters live={live} tx={tx} /> : <p className="text-sm opacity-70">{tx.loading}</p>}
      </div>
      {summary && (
        <div className="body-panel-summary">
          <h3>{tx.panelSummary}</h3>
          <SummaryView summary={summary} tx={tx} lang={lang} />
        </div>
      )}
    </section>
  );
}

function Meter({ label, value, good }: { label: string; value: number; good: number }) {
  return (
    <div className="text-sm">
      <div className="flex justify-between">
        <span>{label}</span>
        <span className="tabular-nums">{pct(value)}</span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-white/10">
        <div
          className="h-full rounded-full"
          style={{ width: pct(value), background: value >= good ? "#3fb950" : "#d29922", transition: "width 0.3s" }}
        />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="opacity-60">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function Strip({ label, cells }: { label: string; cells: string[] }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 opacity-70">{label}</span>
      <div className="flex h-3 flex-1 overflow-hidden rounded">
        {cells.map((color, i) => (
          <span key={i} className="h-full flex-1" style={{ background: color }} />
        ))}
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
