"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

type Vec = [number, number, number];

/**
 * `page` follows the landing page scroll; `auth` is a smaller ring that turns slowly behind the sign-in form;
 * `desk` sits to the right behind the signed-in pitch list.
 */
export type SceneVariant = "page" | "auth" | "desk";

/**
 * A black titanium ring of fins that pulse and light up like a voice. Seen from the side at the top
 * of the page, and through its middle at the bottom, where a slide appears inside it.
 */
const RING_RADIUS = 3.2;
const FIN_OUTER = 1.15;
const FIN_INNER = 0.62;
const FIN_DEPTH = 0.018;
const FIN_TILT = 0.45;
const BG = 0x050505;
const TITANIUM = new THREE.Color(0x34373c);
const VOICE_GLOW = new THREE.Color(0xb7b1ff);
const ACCENT = "#8f88ff";

// Camera path over the page scroll (0 = top, 1 = bottom).
const KEYS: { at: number; pos: Vec; look: Vec }[] = [
  { at: 0, pos: [5.4, -2.2, 2.6], look: [2.2, 0.6, 0] },
  { at: 0.3, pos: [4.6, 2.6, 4.2], look: [1.6, 0.9, 0] },
  { at: 0.6, pos: [-0.6, -5.2, 2.8], look: [-1.8, -1.2, 0] },
  { at: 0.85, pos: [0, -0.4, 8.6], look: [0, 0, 0] },
  { at: 1, pos: [0, 0, 6.2], look: [0, 0, 0] },
];

// How far right of the text the ring sits on screen, per section. Centered for the view through its middle.
const SHIFTS: { at: number; x: number }[] = [
  { at: 0, x: 1.8 },
  { at: 0.3, x: 1.6 },
  { at: 0.6, x: 1.2 },
  { at: 0.85, x: 0 },
];

/** A view that ignores scroll: the camera stays put while the ring turns. */
type FixedView = {
  camera: Vec;
  look: Vec;
  /** Where the camera looks on phones, where the ring stays centered. */
  lookSmall: Vec;
  fog: [near: number, far: number];
  fins: [small: number, large: number];
  spin: number;
};

const FIXED_VIEWS: Record<Exclude<SceneVariant, "page">, FixedView> = {
  // Sign-in screen: a tilted view from a distance so the ring frames the form.
  auth: { camera: [0, -6.2, 13.5], look: [0, 0, 0], lookSmall: [0, 0, 0], fog: [11, 24], fins: [120, 160], spin: 0.1 },
  // Pitch list: looking left of the ring puts it on the right, behind the cards, away from the titles.
  desk: { camera: [-1.4, -6.4, 8.6], look: [-3.4, 0.3, 0], lookSmall: [0, 0.6, 0], fog: [8, 21], fins: [120, 200], spin: 0.06 },
};

const smooth = (t: number) => t * t * (3 - 2 * t);
const ramp = (from: number, to: number, x: number) => smooth(Math.min(1, Math.max(0, (x - from) / (to - from))));

function cameraAt(p: number, pos: THREE.Vector3, look: THREE.Vector3, next: THREE.Vector3) {
  let i = 0;
  while (i < KEYS.length - 2 && p > KEYS[i + 1].at) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const t = ramp(a.at, b.at, p);
  pos.set(...a.pos).lerp(next.set(...b.pos), t);
  look.set(...a.look).lerp(next.set(...b.look), t);
}

function shiftAt(p: number): number {
  let i = 0;
  while (i < SHIFTS.length - 2 && p > SHIFTS[i + 1].at) i++;
  const a = SHIFTS[i];
  const b = SHIFTS[i + 1];
  return a.x + (b.x - a.x) * ramp(a.at, b.at, p);
}

function ringPoint(angle: number, out: THREE.Vector3) {
  return out.set(RING_RADIUS * Math.cos(angle), RING_RADIUS * Math.sin(angle), 0.35 * Math.sin(3 * angle));
}

function finGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape().absarc(0, 0, FIN_OUTER, 0, Math.PI * 2, false);
  shape.holes.push(new THREE.Path().absarc(0, 0, FIN_INNER, 0, Math.PI * 2, true));
  const extruded = new THREE.ExtrudeGeometry(shape, {
    depth: FIN_DEPTH,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 1,
    curveSegments: 32,
  });
  extruded.translate(0, 0, -FIN_DEPTH / 2);
  extruded.deleteAttribute("uv");
  const geometry = mergeVertices(extruded);
  extruded.dispose();
  return geometry;
}

/** Loudness around the ring at a moment: a few syllables travelling round, with fine jitter. */
function voice(angle: number, time: number): number {
  const syllables = Math.max(0, Math.sin(angle * 5 - time * 1.7)) * Math.max(0, Math.sin(angle * 2 + time * 0.6));
  const jitter = 0.5 + 0.5 * Math.sin(angle * 29 + time * 5.3) * Math.sin(angle * 11 - time * 3.1);
  return syllables * (0.55 + 0.45 * jitter);
}

function scrollProgress(): number {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
}

/** A rounded rectangle path. `CanvasRenderingContext2D.roundRect` is missing in older browsers. */
function roundedRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + radius, y);
  g.arcTo(x + w, y, x + w, y + h, radius);
  g.arcTo(x + w, y + h, x, y + h, radius);
  g.arcTo(x, y + h, x, y, radius);
  g.arcTo(x, y, x + w, y, radius);
  g.closePath();
}

/** Slide face for the middle of the ring: layout shapes and a small chart, no real text. */
function slideTexture(): THREE.CanvasTexture {
  const W = 1024;
  const H = 576;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2D canvas unavailable");
  const bar = (x: number, y: number, w: number, h: number, color: string) => {
    g.fillStyle = color;
    roundedRect(g, x, y, w, h, Math.min(w, h) / 2);
    g.fill();
  };
  roundedRect(g, 6, 6, W - 12, H - 12, 44);
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#26262b");
  bg.addColorStop(1, "#141417");
  g.fillStyle = bg;
  g.fill();
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 5;
  g.stroke();
  bar(84, 84, 330, 30, "rgba(242,242,242,0.95)");
  bar(84, 134, 200, 16, "rgba(242,242,242,0.4)");
  [0, 1, 2].forEach((i) => {
    g.fillStyle = ACCENT;
    g.beginPath();
    g.arc(96, 238 + i * 72, 9, 0, Math.PI * 2);
    g.fill();
    bar(124, 229 + i * 72, 330 - i * 60, 18, "rgba(242,242,242,0.55)");
  });
  [130, 190, 160, 260].forEach((h, i) => {
    bar(600 + i * 88, 480 - h, 56, h, i === 3 ? ACCENT : "rgba(242,242,242,0.35)");
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2D canvas unavailable");
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, "rgba(200,196,255,0.55)");
  grad.addColorStop(0.45, "rgba(143,136,255,0.18)");
  grad.addColorStop(1, "rgba(143,136,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// A still scene shows the voice glow as it looks this many seconds in.
const STILL_TIME = 2.2;
// Give up waiting for shader compilation after this long and draw anyway, so the ring never stays hidden.
const COMPILE_TIMEOUT_MS = 2500;
// Frames slower than this on average, even at 1x pixels, switch to the still image.
const TOO_SLOW_MS = 45;

/**
 * Builds the scene and returns a function that tears it down. Never throws: any failure (no WebGL,
 * a lost context, an error while drawing, a GPU too slow to animate) tears the scene down and calls
 * `onFail`, and the page shows the still image instead.
 */
function mountScene(
  el: HTMLDivElement,
  variant: SceneVariant,
  still: boolean,
  onFail: () => void,
  isCancelled: () => boolean,
): () => void {
  const fixed = variant === "page" ? null : FIXED_VIEWS[variant];
  const disposables: { dispose: () => void }[] = [];
  const listeners: [EventTarget, string, EventListener][] = [];
  let renderer: THREE.WebGLRenderer | null = null;
  let frame = 0;
  let running = false;
  let begun = false;
  let dead = false;
  let compileTimer = 0;

  function listen(target: EventTarget, type: string, handler: EventListener) {
    target.addEventListener(type, handler);
    listeners.push([target, type, handler]);
  }

  function teardown() {
    if (dead) return;
    dead = true;
    running = false;
    cancelAnimationFrame(frame);
    window.clearTimeout(compileTimer);
    for (const [target, type, handler] of listeners) target.removeEventListener(type, handler);
    for (const item of disposables) {
      try {
        item.dispose();
      } catch {
        /* already gone with the context */
      }
    }
    if (renderer) {
      try {
        renderer.dispose();
      } catch {
        /* already gone with the context */
      }
      renderer.domElement.remove();
    }
    el.classList.remove("is-ready");
  }

  function fail() {
    if (dead) return;
    teardown();
    onFail();
  }

  try {
    const gl = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer = gl;
    const small = window.matchMedia("(max-width: 640px)").matches;
    gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    gl.setClearColor(BG, 1);
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = 1;
    gl.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(gl.domElement);
    listen(gl.domElement, "webglcontextlost", (event) => {
      event.preventDefault();
      fail();
    });

    const scene = new THREE.Scene();
    scene.fog = fixed ? new THREE.Fog(BG, ...fixed.fog) : new THREE.Fog(BG, 5, 17);
    const pmrem = new THREE.PMREMGenerator(gl);
    const room = new RoomEnvironment();
    const envMap = pmrem.fromScene(room, 0.04).texture;
    disposables.push(envMap, room, pmrem);
    scene.environment = envMap;
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 60);

    const group = new THREE.Group();
    scene.add(group);

    // Black titanium fins. The material stays white; each fin's colour carries the titanium tone and the voice glow.
    const fin = finGeometry();
    const finMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.24, envMapIntensity: 0.9 });
    const count = fixed ? fixed.fins[small ? 0 : 1] : small ? 180 : 300;
    const fins = new THREE.InstancedMesh(fin, finMaterial, count);
    disposables.push(fin, finMaterial, fins);
    fins.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zAxis = new THREE.Vector3(0, 0, 1);
    const ahead = new THREE.Vector3();
    const radial = new THREE.Vector3();
    const tilt = new THREE.Quaternion();
    const rest = Array.from({ length: count }, (_, i) => {
      const angle = (i / count) * Math.PI * 2;
      const center = ringPoint(angle, new THREE.Vector3());
      const tangent = ringPoint(angle + 0.001, ahead).sub(center).normalize();
      radial.set(Math.cos(angle), Math.sin(angle), 0);
      const facing = new THREE.Quaternion().setFromUnitVectors(zAxis, tangent);
      tilt.setFromAxisAngle(radial, FIN_TILT);
      fins.setColorAt(i, TITANIUM);
      return { angle, center, rotation: tilt.clone().multiply(facing) };
    });
    group.add(fins);

    // The slide that appears inside the ring at the bottom of the page, with a soft glow behind it.
    const slideMap = slideTexture();
    const slideGeometry = new THREE.PlaneGeometry(1.6, 0.9);
    const slideMaterial = new THREE.MeshBasicMaterial({ map: slideMap, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const slide = new THREE.Mesh(slideGeometry, slideMaterial);
    scene.add(slide);
    const glowMap = glowTexture();
    const glowMaterial = new THREE.SpriteMaterial({
      map: glowMap,
      blending: THREE.AdditiveBlending,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    disposables.push(slideMap, slideGeometry, slideMaterial, glowMap, glowMaterial);
    const glowSprite = new THREE.Sprite(glowMaterial);
    glowSprite.scale.set(4.2, 3, 1);
    glowSprite.position.z = -0.05;
    scene.add(glowSprite);

    scene.add(new THREE.AmbientLight(0xffffff, 0.04));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(-4, 6, 6);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xffffff, 1.6);
    rim.position.set(5, -3, -4);
    scene.add(rim);
    const accent = new THREE.PointLight(0x6c63ff, 6, 12, 1.8);
    accent.position.set(-2.5, -2.5, 3);
    scene.add(accent);
    const centerLight = new THREE.PointLight(0xc8c4ff, 0, 8, 1.6);
    scene.add(centerLight);

    const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
    const camPos = new THREE.Vector3();
    const camLook = new THREE.Vector3();
    const scratch = new THREE.Vector3();
    const finScale = new THREE.Vector3();
    const finMatrix = new THREE.Matrix4();
    const finColor = new THREE.Color();
    const startedAt = performance.now();
    let progress = fixed || still ? 0 : scrollProgress();

    /** Updates the scene for a moment `time` seconds in and renders one frame. */
    function draw(time: number) {
      if (!still) {
        if (!fixed) progress += (scrollProgress() - progress) * 0.07;
        mouse.x += (mouse.tx - mouse.x) * 0.05;
        mouse.y += (mouse.ty - mouse.y) * 0.05;
      }

      if (fixed) {
        camPos.set(...fixed.camera);
        camLook.set(...(small ? fixed.lookSmall : fixed.look));
      } else {
        cameraAt(progress, camPos, camLook, scratch);
      }
      if (!small && !fixed) {
        // Slide the camera to its own left so the ring moves right on screen without changing the angle.
        scratch.subVectors(camLook, camPos).cross(camera.up).normalize().multiplyScalar(shiftAt(progress));
        camPos.sub(scratch);
        camLook.sub(scratch);
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);

      fins.rotation.z = time * (fixed ? fixed.spin : 0.04) + progress * 1.4;
      group.rotation.x = mouse.y * 0.08;
      group.rotation.y = mouse.x * 0.1;

      const loudness = 1 - ramp(0.72, 0.95, progress);
      for (let i = 0; i < count; i++) {
        const r = rest[i];
        const v = voice(r.angle, time) * loudness;
        const s = 1 + 0.24 * v;
        finMatrix.compose(r.center, r.rotation, finScale.set(s, s, 1));
        fins.setMatrixAt(i, finMatrix);
        fins.setColorAt(i, finColor.copy(TITANIUM).lerp(VOICE_GLOW, v * 0.55));
      }
      fins.instanceMatrix.needsUpdate = true;
      if (fins.instanceColor) fins.instanceColor.needsUpdate = true;

      const end = fixed ? 0 : ramp(0.8, 0.98, progress);
      slide.visible = glowSprite.visible = end > 0.01;
      slide.scale.setScalar(0.35 + 0.65 * end);
      slide.rotation.set(mouse.y * 0.12, (1 - end) * 0.6 + mouse.x * 0.15, 0);
      slideMaterial.opacity = end;
      glowMaterial.opacity = end;
      centerLight.intensity = 10 * end;

      gl.render(scene, camera);
    }

    function resize() {
      const w = Math.max(1, el.clientWidth);
      const h = Math.max(1, el.clientHeight);
      gl.setSize(w, h, false);
      camera.aspect = w / h;
      camera.fov = camera.aspect < 1 ? 62 : 45;
      camera.updateProjectionMatrix();
    }
    resize();

    // Slow GPUs: after a short sample, drop to 1x pixels; if that is still too slow, use the image.
    let sampled = 0;
    let sampleStart = 0;
    let speedKnown = false;
    function checkSpeed(now: number) {
      if (speedKnown) return;
      sampled++;
      if (sampled === 5) sampleStart = now;
      if (sampled < 50) return;
      const average = (now - sampleStart) / 45;
      sampled = 0;
      if (average > 30 && gl.getPixelRatio() > 1) {
        gl.setPixelRatio(1);
        resize();
        return;
      }
      if (average > TOO_SLOW_MS) {
        fail();
        return;
      }
      speedKnown = true;
    }

    function loop() {
      if (!running || dead) return;
      const now = performance.now();
      try {
        draw((now - startedAt) / 1000);
      } catch {
        fail();
        return;
      }
      checkSpeed(now);
      if (running && !dead) frame = requestAnimationFrame(loop);
    }

    function drawStill() {
      try {
        draw(STILL_TIME);
      } catch {
        fail();
      }
    }

    function start() {
      if (still || running || dead || document.hidden) return;
      running = true;
      sampled = 0;
      frame = requestAnimationFrame(loop);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(frame);
    }

    listen(window, "resize", () => {
      if (dead) return;
      try {
        resize();
      } catch {
        fail();
        return;
      }
      if (still && begun) drawStill();
    });
    if (!still) {
      listen(window, "pointermove", (event) => {
        const e = event as PointerEvent;
        mouse.tx = (e.clientX / window.innerWidth) * 2 - 1;
        mouse.ty = (e.clientY / window.innerHeight) * 2 - 1;
      });
      listen(document, "visibilitychange", () => {
        if (document.hidden) stop();
        else start();
      });
    }

    function begin() {
      if (begun || dead || isCancelled()) return;
      begun = true;
      window.clearTimeout(compileTimer);
      if (still) drawStill();
      else start();
      if (!dead) requestAnimationFrame(() => el.classList.add("is-ready"));
    }

    // Compile shaders off the critical path, then fade the canvas in. Some drivers never finish, so time out.
    compileTimer = window.setTimeout(begin, COMPILE_TIMEOUT_MS);
    gl.compileAsync(scene, camera)
      .catch(() => {
        /* compile on the first frame instead */
      })
      .then(begin);
  } catch {
    fail();
  }

  return teardown;
}

export default function LandingScene({
  onFail,
  variant = "page",
  still = false,
}: {
  onFail: () => void;
  variant?: SceneVariant;
  /** Reduced motion: draw one frame and keep it, with no animation, scrolling camera, or parallax. */
  still?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let cancelled = false;
    let teardown: (() => void) | null = null;
    const build = () => {
      if (!cancelled) teardown = mountScene(el, variant, still, onFail, () => cancelled);
    };
    // Let the page text paint and hydrate first; the ring fades in once it is ready.
    const idle = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(build, { timeout: 1200 }) : null;
    const timer = idle === null ? window.setTimeout(build, 200) : 0;
    return () => {
      cancelled = true;
      if (idle !== null) window.cancelIdleCallback?.(idle);
      window.clearTimeout(timer);
      teardown?.();
    };
  }, [onFail, variant, still]);

  return <div ref={host} className="landing-scene" aria-hidden />;
}
