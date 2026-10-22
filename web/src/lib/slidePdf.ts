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
