import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";
import { tokensFromPdfText } from "./parser.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.mjs", import.meta.url).href;

export async function loadPdf(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return pdfjsLib.getDocument({ data: bytes }).promise;
}

export async function getPdfTextPage(pdf, pageNumber) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ disableCombineTextItems: false });
  const tokens = tokensFromPdfText(content.items, viewport);
  return {
    page,
    viewport,
    tokens,
    meaningfulTextItems: content.items.filter(item => item.str?.trim()).length
  };
}

export async function renderPdfPage(pdf, pageNumber, scale = 2.4) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

export async function renderPdfPreview(pdf, pageNumber, targetCanvas, geometry) {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1.65 });
  targetCanvas.width = Math.ceil(viewport.width);
  targetCanvas.height = Math.ceil(viewport.height);
  const context = targetCanvas.getContext("2d", { alpha: false });
  await page.render({ canvasContext: context, viewport }).promise;

  if (geometry?.sourceWidth && geometry?.sourceHeight) {
    const scaleX = targetCanvas.width / geometry.sourceWidth;
    const scaleY = targetCanvas.height / geometry.sourceHeight;
    context.save();
    context.strokeStyle = "#c31920";
    context.fillStyle = "rgba(195, 25, 32, .12)";
    context.lineWidth = 2;
    context.fillRect(geometry.x * scaleX, geometry.y * scaleY, geometry.width * scaleX, geometry.height * scaleY);
    context.strokeRect(geometry.x * scaleX, geometry.y * scaleY, geometry.width * scaleX, geometry.height * scaleY);
    context.restore();
  }
}

export { pdfjsLib };
