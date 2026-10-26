"use client";

import { useSyncExternalStore } from "react";

let cached: boolean | null = null;

/**
 * Whether this browser can draw the 3D ring at a usable speed. Software-only WebGL (no GPU,
 * graphics acceleration turned off, some remote desktops) reports a major performance caveat and
 * counts as unsupported, so those visitors get the still image instead of a stuttering scene.
 */
export function canUseWebGL(): boolean {
  if (cached !== null) return cached;
  cached = false;
  try {
    const canvas = document.createElement("canvas");
    const options = { failIfMajorPerformanceCaveat: true };
    const gl = (canvas.getContext("webgl2", options) ?? canvas.getContext("webgl", options)) as WebGLRenderingContext | null;
    if (gl) {
      cached = true;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    cached = false;
  }
  return cached;
}

const noSubscribe = () => () => {};

/** `canUseWebGL()` for components: false on the server and during hydration, then the real answer. */
export function useWebGL(): boolean {
  return useSyncExternalStore(noSubscribe, canUseWebGL, () => false);
}
