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

export async function readSlideText(doc: PDFDocumentProxy, maxPages = 8): Promise<string> {
  const pages = Math.min(doc.numPages, maxPages);
  const chunks: string[] = [];
  for (let number = 1; number <= pages; number++) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ("str" in item && typeof item.str === "string" ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (line) chunks.push(`${number}. ${line}`);
  }
  return chunks.join("\n").slice(0, 12000);
}
