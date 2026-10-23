import type { PDFDocumentProxy } from "pdfjs-dist";

let workerReady = false;

export async function openPdf(data: Uint8Array): Promise<PDFDocumentProxy> {
  const pdfjs = await import("pdfjs-dist");
  if (!workerReady) {
    pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
    workerReady = true;
  }
  return pdfjs.getDocument({ data }).promise;
}

export function paintPage(doc: PDFDocumentProxy, pageNumber: number, canvas: HTMLCanvasElement, width: number) {
  return doc.getPage(pageNumber).then((page) => {
    const base = page.getViewport({ scale: 1 });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const viewport = page.getViewport({ scale: (Math.max(width, 320) / base.width) * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    return page.render({ canvas, viewport });
  });
}

// ---- Hiding animation steps and empty pages -------------------------------------------------
// Figma Slides (and Smart Animate in general) animates by duplicating a slide and changing it,
// so an exported PDF has several near-identical pages in a row. PDFs can't hold the animation,
// so we show only the final state of each build and drop pages that are completely empty.

const THUMB_WIDTH = 64;
const BLANK_SPREAD = 6; // grey-level standard deviation below this: a single flat colour
const STEP_DIFF = 28; // mean grey-level difference: below this, two pages share one layout
const DUPLICATE_DIFF = 8; // for text-less pages, near-identical images

type PageInfo = { words: Set<string>; pixels: Float32Array; spread: number };

async function pageText(doc: PDFDocumentProxy, number: number): Promise<string> {
  const page = await doc.getPage(number);
  const content = await page.getTextContent();
  return content.items
    .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function pageInfo(doc: PDFDocumentProxy, number: number): Promise<PageInfo> {
  const words = new Set((await pageText(doc, number)).toLowerCase().match(/[\p{L}\p{N}%]+/gu) ?? []);
  const page = await doc.getPage(number);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvas, viewport }).promise;
  const data = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixels = new Float32Array(data ? data.length / 4 : 0);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = 0.299 * data![i * 4] + 0.587 * data![i * 4 + 1] + 0.114 * data![i * 4 + 2];
  }
  const mean = pixels.reduce((a, b) => a + b, 0) / (pixels.length || 1);
  const spread = Math.sqrt(pixels.reduce((a, b) => a + (b - mean) ** 2, 0) / (pixels.length || 1));
  return { words, pixels, spread };
}

function difference(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return Infinity; // different page sizes: not a step
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));

/**
 * PDF page numbers worth showing, in order. A page is hidden when it is
 * - empty: no text and a single flat colour, or
 * - an animation step: everything on it reappears on the next page, which looks almost the same.
 * Picture slides without text are kept, and so are different slides that share words
 * (an agenda followed by its first topic looks different, so both stay).
 */
export async function pickSlides(doc: PDFDocumentProxy): Promise<{ pages: number[]; hidden: number }> {
  const infos: PageInfo[] = [];
  for (let n = 1; n <= doc.numPages; n++) infos.push(await pageInfo(doc, n));

  const pages: number[] = [];
  infos.forEach((info, i) => {
    const next = infos[i + 1];
    const empty = info.words.size === 0 && info.spread < BLANK_SPREAD;
    let step = false;
    if (next && !empty) {
      const diff = difference(info.pixels, next.pixels);
      step = info.words.size > 0
        ? isSubset(info.words, next.words) && diff < STEP_DIFF
        : next.words.size === 0 && diff < DUPLICATE_DIFF;
    }
    if (!empty && !step) pages.push(i + 1);
  });
  if (pages.length === 0) pages.push(doc.numPages); // never hide everything
  return { pages, hidden: doc.numPages - pages.length };
}

/** Slide text for the model, numbered as shown (hidden pages skipped). */
export async function readSlideText(doc: PDFDocumentProxy, maxPages = 8, shown?: number[]): Promise<string> {
  const numbers = (shown?.length ? shown : Array.from({ length: doc.numPages }, (_, i) => i + 1)).slice(0, maxPages);
  const chunks: string[] = [];
  for (const [index, number] of numbers.entries()) {
    const line = await pageText(doc, number);
    if (line) chunks.push(`${index + 1}. ${line}`);
  }
  return chunks.join("\n").slice(0, 12000);
}
