"use client";

// The camera window over the presentation. One camera and one pose model serve two features:
// - gestures (the Camera toggle): pointing at the slide, and swipes that change it;
// - body language (the Body language toggle): eye contact (with the face model), hands, posture,
//   measured while the speaker presses Speak, summarized when they stop.
// The skeleton (and the face box, when body language is on) is drawn over the preview.
// Everything runs in the browser: the video is never recorded or uploaded.

import { useEffect, useRef, useState } from "react";
import type { DrawingUtils, FaceLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";
import { quietMediaPipeInfo } from "@/lib/mediapipeLogs";
import { pointingAt, SwipeTracker, type Side, type Swipe } from "@/lib/poseCoach";
import { blendshapeMap, faceSignals, poseSignals, recent, summarize, type FrameSignals, type Summary } from "@/lib/bodySignals";
import { useLang } from "@/lib/i18nClient";

/** How the current slide is going: "idle" once it has been up a while with no pointing at it. */
export type CoachState = "waiting" | "pointed" | "idle" | "wrong";

/** Body-language meters over the last few seconds, for the card under the slide. */
export type BodyLive = ReturnType<typeof recent> & { face: boolean; body: boolean };

const MEDIAPIPE_VERSION = "1.0.1"; // keep in step with package.json
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const POSE_MODEL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HOLD_MS = 400; // pointing must last this long to count
const IDLE_MS = 6000; // a slide shown this long without pointing turns the frame red
const FACE_MS = 66; // the face model runs ~15 times a second; enough for eye contact, easier on the laptop
const LIVE_MS = 500; // how often the body-language meters update
const EYE_COLOR = { contact: "#3fb950", away: "#f85149", down: "#d29922" } as const;

interface Vision {
  pose: PoseLandmarker;
  makeDrawing: (ctx: CanvasRenderingContext2D) => DrawingUtils;
  connections: { start: number; end: number }[];
}

let visionLoad: Promise<Vision> | null = null;
let faceLoad: Promise<FaceLandmarker> | null = null;

function loadVision(): Promise<Vision> {
  visionLoad ??= (async () => {
    const { FilesetResolver, PoseLandmarker, DrawingUtils } = await import("@mediapipe/tasks-vision");
    quietMediaPipeInfo();
    const files = await FilesetResolver.forVisionTasks(WASM_URL);
    const pose = await PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    return { pose, makeDrawing: (ctx: CanvasRenderingContext2D) => new DrawingUtils(ctx), connections: PoseLandmarker.POSE_CONNECTIONS };
  })().catch((err) => {
    visionLoad = null; // let the next attempt try again
    throw err;
  });
  return visionLoad;
}

/** The face model, loaded only when body language is turned on (GPU, else CPU). */
function loadFace(): Promise<FaceLandmarker> {
  faceLoad ??= (async () => {
    const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
    quietMediaPipeInfo();
    const files = await FilesetResolver.forVisionTasks(WASM_URL);
    const make = (delegate: "GPU" | "CPU") =>
      FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: FACE_MODEL, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      });
    return make("GPU").catch(() => make("CPU"));
  })().catch((err) => {
    faceLoad = null;
    throw err;
  });
  return faceLoad;
}

export default function PoseCoach({
  slide,
  slideId,
  onSwipe,
  onState,
  gestures,
  body,
  speaking,
  onBodyLive,
  onBodySummary,
}: {
  slide: Side;
  slideId: number; // changes when the shown slide changes
  onSwipe: (swipe: Swipe) => void;
  onState: (state: CoachState | null) => void;
  gestures: boolean; // pointing and swipes (the Camera toggle)
  body: boolean; // body language (the Body language toggle)
  speaking: boolean; // the Speak button is on: body language records this take
  onBodyLive: (live: BodyLive | null) => void;
  onBodySummary: (summary: Summary | null) => void;
}) {
  const { tr } = useLang();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<"loading" | "on" | "blocked" | "failed">("loading");
  const [faceFailed, setFaceFailed] = useState(false);
  const [points, setPoints] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [state, setState] = useState<CoachState>("waiting");
  const latest = useRef({ slide, slideId, onSwipe, gestures, body, speaking, onBodyLive });
  const face = useRef<FaceLandmarker | null>(null);
  const taken = useRef<FrameSignals[]>([]); // the take being measured (body language, while speaking)

  useEffect(() => {
    latest.current = { slide, slideId, onSwipe, gestures, body, speaking, onBodyLive };
  });

  useEffect(() => {
    onState(phase === "on" && gestures ? state : null);
  }, [phase, state, gestures, onState]);

  useEffect(() => () => onState(null), [onState]);

  // The face model loads the first time body language is turned on.
  useEffect(() => {
    if (!body || face.current) return;
    let cancelled = false;
    loadFace().then(
      (model) => {
        if (!cancelled) face.current = model;
      },
      () => !cancelled && setFaceFailed(true),
    );
    return () => {
      cancelled = true;
    };
  }, [body]);

  // Body language turned off: clear its meters (the camera may stay on for gestures).
  useEffect(() => {
    if (!body) onBodyLive(null);
  }, [body, onBodyLive]);

  // Speak starts a take; Stop summarizes it (only while body language is on).
  useEffect(() => {
    if (speaking && body) {
      taken.current = [];
      onBodySummary(null);
    } else if (!speaking && taken.current.length) {
      onBodySummary(summarize(taken.current));
      taken.current = [];
    }
  }, [speaking, body, onBodySummary]);

  // Mounted only while the camera window is open, so each opening starts its counts from zero.
  useEffect(() => {
    const video = videoRef.current;
    let stopped = false;
    let stream: MediaStream | null = null;
    let frame = 0;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: "user" } });
      } catch {
        if (!stopped) setPhase("blocked");
        return;
      }
      let vision: Vision;
      try {
        vision = await loadVision();
      } catch {
        if (!stopped) setPhase("failed");
        return;
      }
      if (stopped || !video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (stopped) return;
      setPhase("on");

      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d") ?? null;
      const draw = ctx ? vision.makeDrawing(ctx) : null;
      const swipes = new SwipeTracker();
      const started = performance.now();
      const recentFrames: FrameSignals[] = [];
      let lastTime = -1;
      let lastFace = 0;
      let lastLive = 0;
      let facial: Pick<FrameSignals, "eyeContact" | "lookingDown" | "yaw" | "pitch"> & { seen: boolean; box: number[] | null } = {
        eyeContact: false,
        lookingDown: false,
        yaw: null,
        pitch: null,
        seen: false,
        box: null,
      };
      let slideShown = latest.current.slideId;
      let shownAt = performance.now();
      let pointedHere = false; // pointed at the slide on screen
      let holdSince = 0; // when the current pointing began; 0 = not pointing
      let counted = false; // this pointing was already counted
      let wrongNow = false;

      const tick = () => {
        if (stopped) return;
        frame = requestAnimationFrame(tick);
        if (video.readyState < 2 || video.currentTime === lastTime) return;
        lastTime = video.currentTime;
        const now = performance.now();
        const { gestures: gesturesOn, body: bodyOn } = latest.current;
        const lm = vision.pose.detectForVideo(video, now).landmarks[0];
        const aspect = video.videoWidth / (video.videoHeight || 1);

        // ---- Body language: the face (eye contact) a few times a second, the body every frame.
        if (bodyOn && face.current && now - lastFace >= FACE_MS) {
          lastFace = now;
          const f = face.current.detectForVideo(video, now);
          const points = f.faceLandmarks?.[0];
          facial = points
            ? {
                ...faceSignals(blendshapeMap(f.faceBlendshapes?.[0]?.categories), f.facialTransformationMatrixes?.[0]?.data ?? null),
                seen: true,
                box: [
                  Math.min(...points.map((p) => p.x)),
                  Math.min(...points.map((p) => p.y)),
                  Math.max(...points.map((p) => p.x)),
                  Math.max(...points.map((p) => p.y)),
                ],
              }
            : { eyeContact: false, lookingDown: false, yaw: null, pitch: null, seen: false, box: null };
        }
        if (bodyOn) {
          const signals: FrameSignals = {
            t: (now - started) / 1000,
            face: face.current ? facial.seen : false,
            eyeContact: facial.eyeContact,
            lookingDown: facial.lookingDown,
            yaw: facial.yaw,
            pitch: facial.pitch,
            ...poseSignals(lm, aspect),
          };
          recentFrames.push(signals);
          while (recentFrames.length && recentFrames[0].t < signals.t - 6) recentFrames.shift();
          if (latest.current.speaking) taken.current.push(signals);
          if (now - lastLive > LIVE_MS) {
            lastLive = now;
            latest.current.onBodyLive({ ...recent(recentFrames), face: signals.face, body: signals.body });
          }
        }

        // ---- The overlay: the skeleton, and the face box coloured by where the eyes point.
        if (canvas && ctx && draw) {
          if (canvas.width !== video.videoWidth) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          if (lm) {
            draw.drawConnectors(lm, vision.connections, { color: "rgba(255,255,255,0.75)", lineWidth: 3 });
            draw.drawLandmarks(lm, { color: "#8f88ff", radius: 2.5 });
          }
          if (bodyOn && facial.box) {
            const [x0, y0, x1, y1] = facial.box;
            ctx.strokeStyle = EYE_COLOR[facial.lookingDown ? "down" : facial.eyeContact ? "contact" : "away"];
            ctx.lineWidth = 4;
            ctx.strokeRect(x0 * canvas.width, y0 * canvas.height, (x1 - x0) * canvas.width, (y1 - y0) * canvas.height);
          }
        }

        // ---- Gestures: pointing at the slide, and swipes that change it.
        if (!gesturesOn) {
          swipes.reset();
          holdSince = 0;
          return;
        }
        if (latest.current.slideId !== slideShown) {
          // A new slide starts its own wait for pointing.
          slideShown = latest.current.slideId;
          shownAt = now;
          pointedHere = false;
        }
        if (!lm) {
          holdSince = 0;
          swipes.reset();
          return;
        }

        const swipe = swipes.update(lm, aspect, now);
        if (swipe) latest.current.onSwipe(swipe);
        const pointing = swipes.justSwiped(now) ? null : pointingAt(lm, latest.current.slide, aspect);

        if (pointing === "correct") {
          if (!holdSince) holdSince = now;
          if (!counted && now - holdSince >= HOLD_MS) {
            counted = true;
            pointedHere = true;
            setPoints((n) => n + 1);
          }
        } else {
          holdSince = 0;
          counted = false;
        }
        if (pointing === "wrong" && !wrongNow) setWrong((n) => n + 1);
        wrongNow = pointing === "wrong";

        setState(wrongNow ? "wrong" : pointedHere ? "pointed" : now - shownAt >= IDLE_MS ? "idle" : "waiting");
      };
      frame = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      latest.current.onBodyLive(null);
    };
  }, []);

  const note =
    phase === "loading"
      ? tr("coachLoading")
      : phase === "blocked"
        ? tr("cameraBlocked")
        : phase === "failed"
          ? tr("coachFailed")
          : body && faceFailed
            ? tr("coachFaceFailed")
            : gestures && state === "wrong"
              ? tr("coachWrongHand")
              : gestures && state === "idle"
                ? tr("coachPointHint")
                : null;

  return (
    <div className={body ? "pose-coach is-wide" : "pose-coach"} aria-live="polite">
      <div className="pose-coach-view" hidden={phase !== "on"}>
        <video ref={videoRef} className="pose-coach-video" muted playsInline />
        <canvas ref={canvasRef} className="pose-coach-lines" aria-hidden="true" />
        {body && speaking && <span className="pose-coach-rec">● {tr("coachBodyRecording")}</span>}
      </div>
      {gestures && (
        <p className="pose-coach-count">
          {tr("coachPoints", { n: points })}
          {wrong > 0 && <span> · {tr("coachWrong", { n: wrong })}</span>}
        </p>
      )}
      {note && <p className="pose-coach-note">{note}</p>}
    </div>
  );
}
