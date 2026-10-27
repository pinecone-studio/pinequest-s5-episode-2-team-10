/**
 * Dual-screen Present protocol (same-origin BroadcastChannel).
 *
 * Roles
 * - Controller: FolderDesk on the MacBook (full Saylo UI).
 * - Audience: /present window (slide surface only).
 *
 * Messages
 * - hello { folderId }     audience → all: request current state (reconnect)
 * - state  PresentState    controller → audience: authoritative selection
 * - closed { folderId }    either side: audience gone or controller left the room
 *
 * Rules
 * - Controller is source of truth; audience never writes slide selection back.
 * - state.seq is monotonic per controller tab; audience ignores seq <= last applied
 *   unless folderId changed (folder switch).
 * - slideRev bumps only when slide bytes change; page flips keep the same slideRev.
 * - openPresentWindow reuses name "saylo-present"; Window Management API is optional.
 */

export const PRESENT_CHANNEL = "saylo-present-v1";

export type PresentMode = "pdf" | "image" | "figma";

export type PresentState = {
  folderId: string;
  /** Monotonic per controller; drops stale/out-of-order updates. */
  seq: number;
  page: number;
  pageCount: number;
  shownPages: number[];
  mode: PresentMode;
  /** Bumps whenever the presenter reloads slide bytes (replace PDF/image). */
  slideRev: number;
  figmaUrl?: string | null;
};

export type PresentMsg =
  | { type: "hello"; folderId: string }
  | ({ type: "state" } & PresentState)
  | { type: "closed"; folderId: string };

function isPresentState(data: Record<string, unknown>): data is PresentState & { type: "state" } {
  return (
    data.type === "state" &&
    typeof data.folderId === "string" &&
    typeof data.seq === "number" &&
    typeof data.page === "number" &&
    typeof data.pageCount === "number" &&
    Array.isArray(data.shownPages) &&
    (data.mode === "pdf" || data.mode === "image" || data.mode === "figma") &&
    typeof data.slideRev === "number"
  );
}

function isPresentMsg(data: unknown): data is PresentMsg {
  if (!data || typeof data !== "object") return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== "string" || typeof msg.folderId !== "string") return false;
  if (msg.type === "hello" || msg.type === "closed") return true;
  if (msg.type === "state") return isPresentState(msg);
  return false;
}

let channel: BroadcastChannel | null = null;
let controllerSeq = 0;

function getChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  if (!channel) channel = new BroadcastChannel(PRESENT_CHANNEL);
  return channel;
}

export function postPresent(msg: PresentMsg): void {
  try {
    getChannel()?.postMessage(msg);
  } catch {
    /* channel closed or unsupported */
  }
}

/** Posts authoritative controller state with the next seq. */
export function postPresentState(state: Omit<PresentState, "seq">): void {
  controllerSeq += 1;
  postPresent({ type: "state", ...state, seq: controllerSeq });
}

/** Subscribe to present messages for one folder. Returns unsubscribe. */
export function subscribePresent(folderId: string, onMsg: (msg: PresentMsg) => void): () => void {
  return subscribePresentAll((msg) => {
    if (msg.folderId !== folderId) return;
    onMsg(msg);
  });
}

/** Subscribe to every present message (any folder). Used so the audience can follow folder switches. */
export function subscribePresentAll(onMsg: (msg: PresentMsg) => void): () => void {
  const ch = getChannel();
  if (!ch) return () => {};

  const handler = (event: MessageEvent) => {
    if (!isPresentMsg(event.data)) return;
    onMsg(event.data);
  };
  ch.addEventListener("message", handler);
  return () => ch.removeEventListener("message", handler);
}

/** Screen from the multi-screen Window Management API (Chromium). */
type PresentScreen = {
  left: number;
  top: number;
  width: number;
  height: number;
  availLeft?: number;
  availTop?: number;
  availWidth?: number;
  availHeight?: number;
  isPrimary?: boolean;
  isInternal?: boolean;
  label?: string;
};

type ScreenDetailsLike = {
  screens: PresentScreen[];
  currentScreen?: PresentScreen;
};

async function externalScreen(): Promise<PresentScreen | null> {
  const w = window as Window & {
    getScreenDetails?: () => Promise<ScreenDetailsLike>;
  };
  if (typeof w.getScreenDetails !== "function") return null;
  try {
    const details = await w.getScreenDetails();
    const screens = details.screens ?? [];
    if (screens.length < 2) return null;
    const current = details.currentScreen;
    const other =
      screens.find((s) => current && (s.left !== current.left || s.top !== current.top)) ??
      screens.find((s) => s.isPrimary === false) ??
      screens.find((s) => s.isInternal === false) ??
      null;
    return other;
  } catch {
    return null;
  }
}

export type OpenPresentResult = {
  win: Window | null;
  /** True when the window was positioned on a second display via Window Management API. */
  onExternal: boolean;
  /** True when an existing audience window was focused instead of opening a new one. */
  reused: boolean;
};

/**
 * Opens or reuses the slide-only audience page. Tries to place a new window on an
 * external display when allowed; otherwise opens a normal popup to drag manually.
 */
export async function openPresentWindow(
  folderId: string,
  existing: Window | null = null,
): Promise<OpenPresentResult> {
  if (existing && !existing.closed) {
    try {
      existing.focus();
    } catch {
      /* ignore */
    }
    return { win: existing, onExternal: false, reused: true };
  }

  const url = `/present?folder=${encodeURIComponent(folderId)}&fs=1`;
  const name = "saylo-present";
  const screen = await externalScreen();
  if (screen) {
    const left = Math.round(screen.availLeft ?? screen.left);
    const top = Math.round(screen.availTop ?? screen.top);
    const width = Math.round(screen.availWidth ?? screen.width);
    const height = Math.round(screen.availHeight ?? screen.height);
    const features = `popup=yes,left=${left},top=${top},width=${width},height=${height}`;
    const win = window.open(url, name, features);
    if (win) {
      try {
        win.moveTo(left, top);
        win.resizeTo(width, height);
      } catch {
        /* some browsers block moveTo after open */
      }
      return { win, onExternal: true, reused: false };
    }
  }
  return { win: window.open(url, name), onExternal: false, reused: false };
}
