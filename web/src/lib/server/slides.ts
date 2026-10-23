// Server only: turns PowerPoint / OpenDocument decks into PDF with LibreOffice, so the folder
// page (which draws PDF pages with pdf.js) can show them.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_DECK_BYTES = 50 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 120_000;
const PROFILE_DIR = path.join(os.tmpdir(), "saylo-libreoffice-profile");

export type DeckKind = "pptx" | "ppt" | "odp";

export class SlideError extends Error {
  readonly code: "no_office" | "wrong_type" | "too_big" | "failed";
  readonly status: number;

  // Plain fields, not constructor shorthand: some compilers reset shorthand fields after the constructor.
  constructor(code: "no_office" | "wrong_type" | "too_big" | "failed", status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

/** LibreOffice's command-line program: LIBREOFFICE_PATH, or the usual install places. */
export function sofficePath(): string | null {
  const candidates = [
    process.env.LIBREOFFICE_PATH?.trim(),
    "B:\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files\\LibreOffice\\program\\soffice.exe",
    "C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/soffice",
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  ];
  return candidates.find((p): p is string => Boolean(p) && existsSync(p as string)) ?? null;
}

/** What the file really is, from its first bytes and name. PPTX and ODP are zip files; PPT is an OLE file. */
export function deckKind(bytes: Uint8Array, name: string): DeckKind | null {
  const ext = path.extname(name).toLowerCase();
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;
  if (zip && ext === ".pptx") return "pptx";
  if (zip && ext === ".odp") return "odp";
  if (ole && ext === ".ppt") return "ppt";
  return null;
}

// LibreOffice handles one conversion at a time per profile; run them in turn.
let queue: Promise<unknown> = Promise.resolve();

export function convertDeckToPdf(bytes: Uint8Array, kind: DeckKind): Promise<Buffer> {
  const job = queue.then(() => convert(bytes, kind));
  queue = job.catch(() => undefined);
  return job;
}

async function convert(bytes: Uint8Array, kind: DeckKind): Promise<Buffer> {
  const soffice = sofficePath();
  if (!soffice) throw new SlideError("no_office", 503);
  const dir = await mkdtemp(path.join(os.tmpdir(), "saylo-deck-"));
  try {
    const input = path.join(dir, `deck.${kind}`);
    await writeFile(input, bytes);
    const args = [
      "--headless",
      "--norestore",
      "--nolockcheck",
      // Our own profile, so a LibreOffice window the user has open doesn't block the conversion.
      // It is reused (conversions run one at a time); creating it costs ~10 s per run.
      `-env:UserInstallation=${pathToFileURL(PROFILE_DIR).href}`,
      "--convert-to",
      "pdf",
      "--outdir",
      dir,
      input,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(/*turbopackIgnore: true*/ soffice, args, { stdio: "ignore", windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        reject(new SlideError("failed", 504));
      }, CONVERT_TIMEOUT_MS);
      child.on("error", () => {
        clearTimeout(timer);
        reject(new SlideError("failed", 500));
      });
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    const pdf = await readFile(path.join(dir, "deck.pdf")).catch(() => null);
    if (!pdf || pdf.subarray(0, 4).toString("latin1") !== "%PDF") throw new SlideError("failed", 422);
    return pdf;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
