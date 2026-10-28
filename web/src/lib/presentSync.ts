/**
 * Dual-screen Present protocol (same-origin BroadcastChannel).
 *
 * Controller: FolderDesk on the MacBook. Audience: /present (slides only).
 * Requires macOS Extend (not Mirror). No auto document.fullscreen — that pins
 * the window to one display; the audience uses CSS theatre instead.
 *
 * Messages: hello | state | closed. Controller owns selection; state.seq is
 * monotonic; slideRev bumps only when slide bytes change.
 */

export const PRESENT_CHANNEL = "saylo-present-v1";

export type PresentMode = "pdf" | "image" | "figma";

export type PresentState = {
  folderId: string;
  seq: number;
  page: number;
  pageCount: number;
  shownPages: number[];
  mode: PresentMode;
  slideRev: number;
  figmaUrl?: string | null;
};

export type PresentMsg =
  | { type: "hello"; folderId: string }
  | ({ type: "state" } & PresentState)
  | { type: "closed"; folderId: string };

export type DisplayLayout = "extended" | "single" | "unknown";

export type OpenPresentResult = {
  win: Window | null;
  onExternal: boolean;
  reused: boolean;
  layout: DisplayLayout;
};

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
};

type ScreenDetailsLike = {
  screens: PresentScreen[];
  currentScreen?: PresentScreen;
};

type WindowWithScreens = Window & {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
};

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

export function postPresentState(state: Omit<PresentState, "seq">): void {
  controllerSeq += 1;
  postPresent({ type: "state", ...state, seq: controllerSeq });
}

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

/** Mirror reports one logical screen; Extend reports isExtended or 2+ screens. */
export async function detectDisplayLayout(): Promise<DisplayLayout> {
  const s = window.screen as Screen & { isExtended?: boolean };
  if (typeof s.isExtended === "boolean") {
    return s.isExtended ? "extended" : "single";
  }
  const w = window as WindowWithScreens;
  if (typeof w.getScreenDetails !== "function") return "unknown";
  try {
    const details = await w.getScreenDetails();
    return (details.screens?.length ?? 0) >= 2 ? "extended" : "single";
  } catch {
    return "unknown";
  }
}

async function externalScreen(): Promise<PresentScreen | null> {
  const w = window as WindowWithScreens;
  if (typeof w.getScreenDetails !== "function") return null;
  try {
    const details = await w.getScreenDetails();
    const screens = details.screens ?? [];
    if (screens.length < 2) return null;
    const current = details.currentScreen;
    return (
      screens.find((s) => current && (s.left !== current.left || s.top !== current.top)) ??
      screens.find((s) => s.isPrimary === false) ??
      screens.find((s) => s.isInternal === false) ??
      null
    );
  } catch {
    return null;
  }
}

function placedOnExternal(win: Window): boolean {
  if (typeof win.screenX !== "number") return false;
  const primaryW = window.screen?.availWidth ?? 0;
  return win.screenX < -10 || win.screenX > primaryW - 40;
}

function openAudience(url: string, name: string, features?: string): Window | null {
  return features ? window.open(url, name, features) : window.open(url, name);
}

/**
 * Opens or reuses the slide-only audience page. Places on an external display
 * when Extend + Window Management allow; otherwise a popup to drag manually.
 */
export async function openPresentWindow(
  folderId: string,
  existing: Window | null = null,
): Promise<OpenPresentResult> {
  const layout = await detectDisplayLayout();
  const url = `/present?folder=${encodeURIComponent(folderId)}`;
  const name = "saylo-present";

  if (existing && !existing.closed) {
    try {
      existing.focus();
    } catch {
      /* ignore */
    }
    return { win: existing, onExternal: false, reused: true, layout };
  }

  if (layout === "extended") {
    const screen = await externalScreen();
    if (screen) {
      const left = Math.round(screen.availLeft ?? screen.left);
      const top = Math.round(screen.availTop ?? screen.top);
      const width = Math.round(screen.availWidth ?? screen.width);
      const height = Math.round(screen.availHeight ?? screen.height);
      const win = openAudience(url, name, `popup=yes,left=${left},top=${top},width=${width},height=${height}`);
      if (win) {
        try {
          win.moveTo(left, top);
          win.resizeTo(width, height);
        } catch {
          /* moveTo often blocked */
        }
        return { win, onExternal: placedOnExternal(win), reused: false, layout };
      }
    }
  }

  return {
    win: openAudience(url, name, "popup=yes,width=1280,height=720"),
    onExternal: false,
    reused: false,
    layout,
  };
}
