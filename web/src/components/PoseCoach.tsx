"use client";

// While the camera is on, watches the speaker for pointing at the slide and for swipes that change it.
// Everything runs in the browser: the video is never recorded or uploaded.

import { useEffect, useRef, useState } from "react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import { pointingAt, SwipeTracker, type Side, type Swipe } from "@/lib/poseCoach";
import { useLang } from "@/lib/i18nClient";

/** How the current slide is going: "idle" once it has been up a while with no pointing at it. */
export type CoachState = "waiting" | "pointed" | "idle" | "wrong";

const MEDIAPIPE_VERSION = "1.0.1"; // keep in step with package.json
const WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HOLD_MS = 400; // pointing must last this long to count
const IDLE_MS = 6000; // a slide shown this long without pointing turns the frame red

let landmarker: Promise<PoseLandmarker> | null = null;

function loadLandmarker(): Promise<PoseLandmarker> {
  landmarker ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
    const files = await FilesetResolver.forVisionTasks(WASM_URL);
    return PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  })().catch((err) => {
    landmarker = null; // let the next attempt try again
    throw err;
  });
  return landmarker;
}

export default function PoseCoach({
  slide,
  slideId,
  onSwipe,
  onState,
}: {
  slide: Side;
  slideId: number; // changes when the shown slide changes
  onSwipe: (swipe: Swipe) => void;
  onState: (state: CoachState | null) => void;
}) {
  const { tr } = useLang();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<"loading" | "on" | "blocked" | "failed">("loading");
  const [points, setPoints] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [state, setState] = useState<CoachState>("waiting");
  const latest = useRef({ slide, slideId, onSwipe });

  useEffect(() => {
    latest.current = { slide, slideId, onSwipe };
  });

  useEffect(() => {
    onState(phase === "on" ? state : null);
  }, [phase, state, onState]);

  useEffect(() => () => onState(null), [onState]);

  // Mounted only while the camera is on, so each opening starts its counts from zero.
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
      let pose: PoseLandmarker;
      try {
        pose = await loadLandmarker();
      } catch {
        if (!stopped) setPhase("failed");
        return;
      }
      if (stopped || !video) return;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      if (stopped) return;
      setPhase("on");

      const swipes = new SwipeTracker();
      let lastTime = -1;
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
        if (latest.current.slideId !== slideShown) {
          // A new slide starts its own wait for pointing.
          slideShown = latest.current.slideId;
          shownAt = now;
          pointedHere = false;
        }
        const lm = pose.detectForVideo(video, now).landmarks[0];
        const aspect = video.videoWidth / (video.videoHeight || 1);
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
    };
  }, []);

  const note =
    phase === "loading"
      ? tr("coachLoading")
      : phase === "blocked"
        ? tr("cameraBlocked")
        : phase === "failed"
          ? tr("coachFailed")
          : state === "wrong"
            ? tr("coachWrongHand")
            : state === "idle"
              ? tr("coachPointHint")
              : null;

  return (
    <div className="pose-coach" aria-live="polite">
      <video ref={videoRef} className="pose-coach-video" muted playsInline hidden={phase !== "on"} />
      <p className="pose-coach-count">
        {tr("coachPoints", { n: points })}
        {wrong > 0 && <span> · {tr("coachWrong", { n: wrong })}</span>}
      </p>
      {note && <p className="pose-coach-note">{note}</p>}
    </div>
  );
}
