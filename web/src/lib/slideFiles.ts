// Which slide files the folder page takes, and turning decks into something it can show.

import { t } from "./i18n";
import { currentLang, langHeaders } from "./i18nClient";

// Every type listed explicitly. A bare "image/*" makes some Windows file dialogs open in an
// images-only filter, which hides PDFs.
export const SLIDE_ACCEPT = [
  ".pdf", "application/pdf",
  ".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".ppt", "application/vnd.ms-powerpoint",
  ".odp", "application/vnd.oasis.opendocument.presentation",
  ".png", ".jpg", ".jpeg", ".webp", ".gif", "image/png", "image/jpeg", "image/webp", "image/gif",
].join(",");

export type SlideKind = "pdf" | "image" | "deck";

/** What the file really is, from its first bytes (not its name or the browser's guess). */
export async function slideKind(file: File): Promise<SlideKind | null> {
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  if (ascii(0, 4) === "%PDF") return "pdf";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "image";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  if (ascii(0, 4) === "GIF8") return "image";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image";
  const zip = b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  const ole = b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0;
  if ((zip && (ext === "pptx" || ext === "odp")) || (ole && ext === "ppt")) return "deck";
  return null;
}

/**
 * A file the page can show: PDFs and images as they are, decks converted to PDF on the server.
 * Throws an Error with a message for the page.
 */
export async function prepareSlide(file: File): Promise<File> {
  const lang = currentLang();
  const kind = await slideKind(file);
  if (!kind) throw new Error(t(lang, "slideWrongType"));
  if (kind !== "deck") return file;

  const form = new FormData();
  form.set("file", file, file.name);
  let res: Response;
  try {
    res = await fetch("/api/slides/convert", { method: "POST", body: form, headers: langHeaders() });
  } catch {
    throw new Error(t(lang, "serverUnreachable"));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || t(lang, "deckConvertFailed"));
  }
  const pdfName = file.name.replace(/\.(pptx|ppt|odp)$/i, "") + ".pdf";
  return new File([await res.blob()], pdfName, { type: "application/pdf" });
}
