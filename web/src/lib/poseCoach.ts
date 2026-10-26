// Reads MediaPipe pose landmarks while the speaker presents: is a hand pointing at the slide,
// and did a hand swipe across the body (to change slides). Plain rules on landmark positions,
// so they are deterministic; they say where the arms are, not how well someone presents.

/** The landmark fields this module reads (MediaPipe's NormalizedLandmark has these). */
export interface Point {
  x: number; // 0..1 across the camera image
  y: number; // 0..1 down the camera image
  visibility?: number;
}

/** Which side of the speaker the slide or TV is, as the speaker faces the audience. */
export type Side = "left" | "right";
export type Pointing = "correct" | "wrong" | null;
export type Swipe = "next" | "prev";

// MediaPipe pose landmark indices.
const NOSE = 0;
const SHOULDER = { left: 11, right: 12 } as const;
const ELBOW = { left: 13, right: 14 } as const;
const WRIST = { left: 15, right: 16 } as const;
const HIP = { left: 23, right: 24 } as const;

const MIN_VISIBLE = 0.5;
const POINT_REACH = 0.9; // the wrist is this many shoulder widths out past its shoulder
const CROSS_REACH = 0.4; // the other hand, reaching past the slide-side shoulder
const STRAIGHT_ELBOW_DEG = 130;
const SWIPE_DISTANCE = 1.3; // shoulder widths travelled across the body
const SWIPE_WINDOW_MS = 600;
const SWIPE_COOLDOWN_MS = 1200;

const other = (side: Side): Side => (side === "left" ? "right" : "left");

function seen(...points: (Point | undefined)[]): boolean {
  return points.every((p) => p && (p.visibility ?? 1) >= MIN_VISIBLE);
}

/**
 * The speaker's body frame: the mid-shoulder point, the shoulder width, and a unit vector
 * pointing to the speaker's own left. Built from the body, so a mirrored camera does not matter.
 * `aspect` is the image width over its height, to measure x and y in the same units.
 */
function bodyFrame(lm: Point[], aspect: number) {
  const l = lm[SHOULDER.left];
  const r = lm[SHOULDER.right];
  if (!seen(l, r)) return null;
  const dx = (l.x - r.x) * aspect;
  const dy = l.y - r.y;
  const width = Math.hypot(dx, dy);
  if (width < 0.02) return null; // side-on to the camera, or too far away
  return { mid: { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 }, width, toLeft: { x: dx / width, y: dy / width } };
}

/** How far `p` is from `from` toward `side`, in shoulder widths. */
function reach(p: Point, from: Point, side: Side, frame: NonNullable<ReturnType<typeof bodyFrame>>, aspect: number) {
  const along = (p.x - from.x) * aspect * frame.toLeft.x + (p.y - from.y) * frame.toLeft.y;
  return ((side === "left" ? 1 : -1) * along) / frame.width;
}

function elbowAngle(s: Point, e: Point, w: Point, aspect: number): number {
  const ax = (s.x - e.x) * aspect;
  const ay = s.y - e.y;
  const bx = (w.x - e.x) * aspect;
  const by = w.y - e.y;
  const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

function hipLine(lm: Point[]): number {
  const l = lm[HIP.left];
  const r = lm[HIP.right];
  if (seen(l) && seen(r)) return (l.y + r.y) / 2;
  if (seen(l)) return l.y;
  if (seen(r)) return r.y;
  return 1; // hips out of frame: anything on screen is above them
}

/**
 * "correct": the slide-side hand is held out toward the slide with a fairly straight arm, above the hips.
 * "wrong": the other hand reaches across the body toward the slide, which turns the back to the audience.
 */
export function pointingAt(lm: Point[], slide: Side, aspect: number): Pointing {
  const frame = bodyFrame(lm, aspect);
  if (!frame) return null;
  const hips = hipLine(lm);

  const s = lm[SHOULDER[slide]];
  const e = lm[ELBOW[slide]];
  const w = lm[WRIST[slide]];
  if (
    seen(e, w) &&
    w.y < hips &&
    reach(w, s, slide, frame, aspect) >= POINT_REACH &&
    elbowAngle(s, e, w, aspect) >= STRAIGHT_ELBOW_DEG
  ) {
    return "correct";
  }

  const cross = lm[WRIST[other(slide)]];
  if (seen(cross) && cross.y < hips && reach(cross, s, slide, frame, aspect) >= CROSS_REACH) return "wrong";
  return null;
}

type Sample = { t: number; pos: number };

/**
 * Spots a quick sweep of either hand across the front of the body. Moving toward the speaker's
 * own left turns to the next slide (like turning a page); toward the right goes back.
 */
export class SwipeTracker {
  private trails: Record<Side, Sample[]> = { left: [], right: [] };
  private last = -Infinity;

  update(lm: Point[], aspect: number, now: number): Swipe | null {
    const frame = bodyFrame(lm, aspect);
    if (!frame) {
      this.reset();
      return null;
    }
    const hips = hipLine(lm);
    const nose = lm[NOSE];
    for (const hand of ["left", "right"] as const) {
      const w = lm[WRIST[hand]];
      const trail = this.trails[hand];
      // A swipe is made at chest height: above the hips, below the head.
      if (!seen(w) || w.y > hips || (seen(nose) && w.y < nose.y)) {
        trail.length = 0;
        continue;
      }
      trail.push({ t: now, pos: reach(w, frame.mid, "left", frame, aspect) });
      while (trail.length && now - trail[0].t > SWIPE_WINDOW_MS) trail.shift();
      if (now - this.last < SWIPE_COOLDOWN_MS) continue;

      const first = trail[0];
      const lastPos = trail[trail.length - 1].pos;
      const travelled = lastPos - first.pos;
      // It must cross the middle of the body, so holding an arm out to point is not a swipe.
      const crossed = Math.min(first.pos, lastPos) < 0 && Math.max(first.pos, lastPos) > 0;
      if (Math.abs(travelled) >= SWIPE_DISTANCE && crossed) {
        this.last = now;
        this.reset();
        return travelled > 0 ? "next" : "prev";
      }
    }
    return null;
  }

  /** True for a moment after a swipe, so the arm sweeping out is not also counted as pointing. */
  justSwiped(now: number): boolean {
    return now - this.last < SWIPE_COOLDOWN_MS;
  }

  reset() {
    this.trails = { left: [], right: [] };
  }
}
