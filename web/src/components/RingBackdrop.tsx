"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useRingTier } from "@/lib/webgl";
import type { SceneQuality, SceneVariant } from "./LandingScene";

type SceneProps = { onFail: () => void; variant?: SceneVariant; quality?: SceneQuality; gentle?: boolean };

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

/** A picture of the real 3D ring, turning slowly, for browsers that can't draw it. */
export function StaticRing({ variant = "page" }: { variant?: SceneVariant }) {
  return <div className={variant === "page" ? "landing-fallback is-animated" : `landing-fallback is-${variant} is-animated`} aria-hidden />;
}

/**
 * The ribbed ring behind the landing, sign-in, and pitch list pages. Full 3D on a real GPU, a
 * lighter 3D scene on software rendering or weak GPUs, and the turning picture when WebGL2 is
 * missing or the scene fails at any point. Reduced motion slows it down rather than stopping it.
 */
export default function RingBackdrop({ variant = "page" }: { variant?: SceneVariant }) {
  const tier = useRingTier();
  const reduced = useReducedMotion();
  const [failed, setFailed] = useState(false);
  const onFail = useCallback(() => setFailed(true), []);

  if (tier === "css" || failed) return <StaticRing variant={variant} />;
  return <LandingScene variant={variant} quality={tier} gentle={reduced} onFail={onFail} />;
}
