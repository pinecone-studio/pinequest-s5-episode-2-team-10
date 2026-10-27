"use client";

import { useSyncExternalStore } from "react";

/**
 * How the 3D ring is drawn here. `full`: WebGL2 on a real GPU. `lite`: WebGL2 that is software
 * rendered or on a weak GPU (graphics acceleration off, blocklisted drivers, remote desktops), so
 * a lighter scene. `css`: no WebGL2 at all (three.js needs it), so an animated picture.
 */
export type RingTier = "full" | "lite" | "css";

const TIERS: readonly RingTier[] = ["full", "lite", "css"];
let cached: RingTier | null = null;

function opensWebGL2(failIfMajorPerformanceCaveat: boolean): boolean {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat }) as WebGL2RenderingContext | null;
  if (!gl) return false;
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return true;
}

/** In development, `?ring=full|lite|css` forces a tier so each one can be checked. */
function forcedTier(): RingTier | null {
  if (process.env.NODE_ENV !== "development") return null;
  const value = new URLSearchParams(window.location.search).get("ring");
  return TIERS.includes(value as RingTier) ? (value as RingTier) : null;
}

export function ringTier(): RingTier {
  if (cached) return cached;
  cached = forcedTier();
  if (cached) return cached;
  try {
    cached = opensWebGL2(true) ? "full" : opensWebGL2(false) ? "lite" : "css";
  } catch {
    cached = "css";
  }
  return cached;
}

const noSubscribe = () => () => {};

/** `ringTier()` for components: `css` on the server and during hydration, then the real answer. */
export function useRingTier(): RingTier {
  return useSyncExternalStore(noSubscribe, ringTier, () => "css");
}
