// Body-language signals from MediaPipe face and pose landmarks (prototype).
// Only things a camera can measure: where the head and eyes point, whether hands are visible and
// moving, swaying, shoulder tilt, distance from the camera. No emotion or "confidence" judgements.

export interface Point {
  x: number; // 0..1 of the frame width
  y: number; // 0..1 of the frame height
  z?: number;
  visibility?: number;
}

export interface FrameSignals {
  t: number; // seconds since the practice started
  face: boolean;
  eyeContact: boolean; // facing the camera, eyes not looking down or away
  lookingDown: boolean; // eyes down, e.g. reading notes
  yaw: number | null; // head turn left/right, degrees
  pitch: number | null; // head tilt up/down, degrees
  body: boolean;
  handsVisible: boolean;
  shoulderTilt: number | null; // degrees from level
  center: number | null; // shoulder midpoint x (0..1)
  shoulderWidth: number | null; // fraction of the frame width
  leftWrist: Point | null;
  rightWrist: Point | null;
}

// Thresholds, first guesses: tune them on our own recordings.
export const LIMITS = {
  yaw: 20, // degrees either way still counts as facing the camera
  pitch: 20,
  lookDown: 0.45, // eyeLookDown blendshape
  lookSide: 0.5,
  visible: 0.5, // landmark visibility
  tilt: 8, // shoulder tilt in degrees
  still: 0.35, // how far a wrist ranges in one second, in shoulder widths: below this, hands are still
  wild: 1.2, // above this, hands move a lot (detector jitter on crossed arms reaches ~0.33)
  sway: 0.06, // std of shoulder midpoint over 3 s, in shoulder widths
  far: 0.18, // shoulder width below this fraction of the frame: too far from the camera
  near: 0.6,
};

const deg = (rad: number) => (rad * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Head yaw and pitch (degrees) from MediaPipe's 4x4 facial transformation matrix (column-major). */
export function headAngles(m: ArrayLike<number>): { yaw: number; pitch: number } {
  const r02 = m[8], r12 = m[9], r22 = m[10];
  return { yaw: deg(Math.atan2(r02, r22)), pitch: deg(Math.asin(clamp(-r12, -1, 1))) };
}

export function blendshapeMap(categories: { categoryName: string; score: number }[] | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories ?? []) out[c.categoryName] = c.score;
  return out;
}

export function faceSignals(
  blend: Record<string, number>,
  matrix: ArrayLike<number> | null,
): Pick<FrameSignals, "eyeContact" | "lookingDown" | "yaw" | "pitch"> {
  const avg = (a: string, b: string) => ((blend[a] ?? 0) + (blend[b] ?? 0)) / 2;
  const down = avg("eyeLookDownLeft", "eyeLookDownRight");
  // Both eyes looking to the same side: out on one eye means in on the other.
  const side = Math.max(avg("eyeLookOutLeft", "eyeLookInRight"), avg("eyeLookInLeft", "eyeLookOutRight"));
  const angles = matrix ? headAngles(matrix) : null;
  const facing = angles ? Math.abs(angles.yaw) < LIMITS.yaw && Math.abs(angles.pitch) < LIMITS.pitch : true;
  const lookingDown = down > LIMITS.lookDown;
  return {
    lookingDown,
    eyeContact: facing && !lookingDown && side < LIMITS.lookSide,
    yaw: angles ? Math.round(angles.yaw) : null,
    pitch: angles ? Math.round(angles.pitch) : null,
  };
}

const seen = (p: Point | undefined) =>
  !!p && (p.visibility ?? 1) > LIMITS.visible && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

/** Pose signals. `aspect` is frame width / height, so angles use real proportions. */
export function poseSignals(
  lm: Point[] | undefined,
  aspect: number,
): Pick<FrameSignals, "body" | "handsVisible" | "shoulderTilt" | "center" | "shoulderWidth" | "leftWrist" | "rightWrist"> {
  const left = lm?.[11], right = lm?.[12];
  if (!lm || !seen(left) || !seen(right)) {
    return { body: false, handsVisible: false, shoulderTilt: null, center: null, shoulderWidth: null, leftWrist: null, rightWrist: null };
  }
  const dx = (right!.x - left!.x) * aspect;
  const dy = right!.y - left!.y;
  let tilt = Math.abs(deg(Math.atan2(dy, dx)));
  tilt = Math.min(tilt, 180 - tilt);
  const lw = seen(lm[15]) ? lm[15] : null;
  const rw = seen(lm[16]) ? lm[16] : null;
  return {
    body: true,
    handsVisible: !!(lw || rw),
    shoulderTilt: Math.round(tilt * 10) / 10,
    center: (left!.x + right!.x) / 2,
    shoulderWidth: Math.abs(right!.x - left!.x),
    leftWrist: lw,
    rightWrist: rw,
  };
}

// ---- A practice session ---------------------------------------------------------------------------

export type EyeState = "contact" | "away" | "down" | "none";
export type HandState = "active" | "still" | "wild" | "hidden";

export interface Summary {
  seconds: number;
  faceShare: number; // share of time a face was seen
  eyeContact: number; // share of face time
  lookingDown: number;
  handsVisible: number; // share of body time
  handsActive: number; // share of hands-visible time with moderate movement
  handsStill: number;
  handsWild: number;
  swaying: number; // share of body time
  tilted: number;
  framing: "ok" | "far" | "near" | null;
  timeline: { eyes: EyeState; hands: HandState }[]; // one entry per second
  tips: Tip[];
}

export type Tip = "eyeContact" | "lookingDown" | "handsHidden" | "handsStill" | "handsWild" | "swaying" | "tilted" | "far" | "near" | "noFace";

// Hand movement. The wrist landmarks jitter, and when the hands are close together (crossed arms)
// the detector even swaps left and right, so frame-to-frame speed would call still hands "moving".
// Instead: order the wrists by their position in the image (a swap changes nothing), smooth each
// with a short rolling median, then measure how far it ranges over the last second. Smoothing also
// flattens fast waving, so the raw range counts too, minus what jitter alone can reach.
const SMOOTH_S = 0.3;
const MOVE_SPAN_S = 1;
const JITTER = 0.5; // raw range (shoulder widths) that detector jitter reaches on still, crossed arms

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

type Slots = [Point | null, Point | null];

/** Wrists in image order (smaller x first); a single wrist goes to the side where it usually is. */
function wristSlots(f: FrameSignals): Slots {
  const l = f.leftWrist, r = f.rightWrist;
  if (l && r) return l.x <= r.x ? [l, r] : [r, l];
  return [r, l]; // facing the camera, the right wrist is on the image's left
}

/** Rolling median of each wrist slot over the last SMOOTH_S seconds. */
function smoothWrists(frames: FrameSignals[], slots: Slots[]): Slots[] {
  return frames.map((f, i) => {
    const out: Slots = [null, null];
    for (const k of [0, 1] as const) {
      const pts: Point[] = [];
      for (let j = i; j >= 0 && frames[j].t > f.t - SMOOTH_S; j--) if (slots[j][k]) pts.push(slots[j][k]!);
      if (pts.length >= 2) out[k] = { x: median(pts.map((p) => p.x)), y: median(pts.map((p) => p.y)) };
    }
    return out;
  });
}

/** How far the hands moved over the last second, in shoulder widths (null when not measurable). */
function handMovement(frames: FrameSignals[], raw: Slots[], smooth: Slots[], i: number): number | null {
  const f = frames[i];
  if (!f.shoulderWidth || f.t - frames[0].t < MOVE_SPAN_S + SMOOTH_S) return null;
  // Spread of each wrist slot (10th to 90th percentile) over the last second, in shoulder widths.
  const range = (track: Slots[]) => {
    let count = 0;
    const pts: [Point[], Point[]] = [[], []];
    for (let j = i; j >= 0 && frames[j].t > f.t - MOVE_SPAN_S; j--) {
      count++;
      for (const k of [0, 1] as const) if (track[j][k]) pts[k].push(track[j][k]!);
    }
    const ranges = pts
      .filter((p) => p.length >= 3 && p.length >= count / 2)
      .map((p) => {
        const xs = p.map((q) => q.x), ys = p.map((q) => q.y);
        return Math.hypot(quantile(xs, 0.9) - quantile(xs, 0.1), quantile(ys, 0.9) - quantile(ys, 0.1));
      });
    return ranges.length ? Math.max(...ranges) / f.shoulderWidth! : null;
  };
  const smoothed = range(smooth), unsmoothed = range(raw);
  if (smoothed === null || unsmoothed === null) return smoothed ?? unsmoothed;
  return Math.max(smoothed, unsmoothed - JITTER);
}

const share = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

export function summarize(frames: FrameSignals[]): Summary {
  const seconds = frames.length ? frames[frames.length - 1].t - frames[0].t : 0;
  const face = frames.filter((f) => f.face);
  const body = frames.filter((f) => f.body);
  const hands = body.filter((f) => f.handsVisible);

  const moves: number[] = [];
  const handState: HandState[] = frames.map(() => "hidden");
  const raw = frames.map(wristSlots);
  const smooth = smoothWrists(frames, raw);
  for (let i = 0; i < frames.length; i++) {
    if (!frames[i].handsVisible) continue;
    const m = handMovement(frames, raw, smooth, i);
    if (m === null) continue;
    moves.push(m);
    handState[i] = m < LIMITS.still ? "still" : m > LIMITS.wild ? "wild" : "active";
  }

  // Swaying: how much the shoulder midpoint wanders over 3 s windows.
  let swayFrames = 0;
  body.forEach((f, i) => {
    const window = body.filter((g) => g.t > f.t - 3 && g.t <= f.t && g.center !== null);
    if (i > 0 && f.shoulderWidth && window.length > 5) {
      if (std(window.map((g) => g.center!)) / f.shoulderWidth > LIMITS.sway) swayFrames++;
    }
  });

  const widths = body.map((f) => f.shoulderWidth!).sort((a, b) => a - b);
  const medianWidth = widths.length ? widths[Math.floor(widths.length / 2)] : null;
  const framing = medianWidth === null ? null : medianWidth < LIMITS.far ? "far" : medianWidth > LIMITS.near ? "near" : "ok";

  const summary: Omit<Summary, "tips"> = {
    seconds: Math.round(seconds),
    faceShare: share(face.length, frames.length),
    eyeContact: share(face.filter((f) => f.eyeContact).length, face.length),
    lookingDown: share(face.filter((f) => f.lookingDown).length, face.length),
    handsVisible: share(hands.length, body.length),
    handsActive: share(moves.filter((m) => m >= LIMITS.still && m <= LIMITS.wild).length, moves.length),
    handsStill: share(moves.filter((m) => m < LIMITS.still).length, moves.length),
    handsWild: share(moves.filter((m) => m > LIMITS.wild).length, moves.length),
    swaying: share(swayFrames, body.length),
    tilted: share(body.filter((f) => (f.shoulderTilt ?? 0) > LIMITS.tilt).length, body.length),
    framing,
    timeline: perSecond(frames, handState),
  };
  return { ...summary, tips: tipsFor(summary) };
}

function perSecond(frames: FrameSignals[], handState: HandState[]): Summary["timeline"] {
  if (!frames.length) return [];
  const start = frames[0].t;
  const buckets: { eyes: EyeState[]; hands: HandState[] }[] = [];
  frames.forEach((f, i) => {
    const s = Math.floor(f.t - start);
    buckets[s] ??= { eyes: [], hands: [] };
    buckets[s].eyes.push(!f.face ? "none" : f.lookingDown ? "down" : f.eyeContact ? "contact" : "away");
    buckets[s].hands.push(handState[i]);
  });
  const most = <T,>(xs: T[], fallback: T): T => {
    const counts = new Map<T, number>();
    xs.forEach((x) => counts.set(x, (counts.get(x) ?? 0) + 1));
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
  };
  return Array.from(buckets, (b) => ({ eyes: most(b?.eyes ?? [], "none"), hands: most(b?.hands ?? [], "hidden") }));
}

function tipsFor(s: Omit<Summary, "tips">): Tip[] {
  const tips: Tip[] = [];
  if (s.faceShare < 0.5) tips.push("noFace");
  else {
    if (s.lookingDown > 0.25) tips.push("lookingDown");
    if (s.eyeContact < 0.6) tips.push("eyeContact");
  }
  if (s.handsVisible < 0.4) tips.push("handsHidden");
  else if (s.handsStill > 0.7) tips.push("handsStill");
  else if (s.handsWild > 0.3) tips.push("handsWild");
  if (s.swaying > 0.3) tips.push("swaying");
  if (s.tilted > 0.3) tips.push("tilted");
  if (s.framing === "far" || s.framing === "near") tips.push(s.framing);
  return tips;
}

/** Shares over the last few seconds, for the live meters. */
export function recent(frames: FrameSignals[], seconds = 5): { eyeContact: number; handsVisible: number; tilt: number | null } {
  const last = frames.length ? frames[frames.length - 1].t : 0;
  const window = frames.filter((f) => f.t > last - seconds);
  const face = window.filter((f) => f.face);
  const body = window.filter((f) => f.body);
  const tilts = body.map((f) => f.shoulderTilt ?? 0);
  return {
    eyeContact: share(face.filter((f) => f.eyeContact).length, face.length),
    handsVisible: share(body.filter((f) => f.handsVisible).length, body.length),
    tilt: tilts.length ? tilts.reduce((a, b) => a + b, 0) / tilts.length : null,
  };
}
