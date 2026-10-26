"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useWebGL } from "@/lib/webgl";
import type { SceneVariant } from "./LandingScene";

type SceneProps = { onFail: () => void; variant?: SceneVariant; still?: boolean };

/** Stands in when the 3D chunk fails to download (offline, blocked): it just reports the failure. */
function SceneImportFailed({ onFail }: SceneProps) {
  useEffect(() => {
    onFail();
  }, [onFail]);
  return null;
}

const LandingScene = dynamic<SceneProps>(
  () => import("./LandingScene").catch(() => ({ default: SceneImportFailed })),
  { ssr: false, loading: () => null },
);

const REDUCED = "(prefers-reduced-motion: reduce)";

export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(REDUCED);
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia(REDUCED).matches,
    () => false,
  );
}

/** A picture of the real 3D ring, for browsers that can't draw it. */
export function StaticRing({ variant = "page" }: { variant?: SceneVariant }) {
  return <div className={variant === "page" ? "landing-fallback" : `landing-fallback is-${variant}`} aria-hidden />;
}

/**
 * The ribbed ring behind the landing, sign-in, and pitch list pages. Animated 3D where WebGL runs well, a still
 * 3D frame when the visitor asks for reduced motion, and the picture whenever WebGL is missing,
 * too slow, or fails at any point.
 */
export default function RingBackdrop({ variant = "page" }: { variant?: SceneVariant }) {
  const webgl = useWebGL();
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const onFail = useCallback(() => setFailed(true), []);

  if (!webgl || failed) return <StaticRing variant={variant} />;
  return <LandingScene variant={variant} still={reduced} onFail={onFail} />;
}
