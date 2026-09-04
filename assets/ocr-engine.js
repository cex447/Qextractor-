import { tokensFromTsv } from "./parser.js";

let workerPromise = null;

function absoluteUrl(relative) {
  return new URL(relative, window.location.href).href;
}

export async function getOcrWorker(onProgress = () => {}) {
  if (!window.Tesseract) throw new Error("El motor OCR no se ha cargado.");
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker("eng", window.Tesseract.OEM.LSTM_ONLY, {
      workerPath: absoluteUrl("./vendor/tesseract/worker.min.js"),
      corePath: absoluteUrl("./vendor/tesseract/core/"),
      langPath: absoluteUrl("./vendor/tesseract/lang/"),
      logger: message => onProgress(message)
    }).then(async worker => {
      await worker.setParameters({
        tessedit_pageseg_mode: window.Tesseract.PSM.SINGLE_BLOCK,
        preserve_interword_spaces: "1",
        user_defined_dpi: "300"
      });
      return worker;
    }).catch(error => {
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

export async function recognizeCanvas(canvas, onProgress = () => {}) {
  const worker = await getOcrWorker(onProgress);
  const result = await worker.recognize(canvas, {}, { text: true, tsv: true });
  return {
    text: result.data.text || "",
    tokens: tokensFromTsv(result.data.tsv),
    width: canvas.width,
    height: canvas.height
  };
}

export async function fileToCanvas(file) {
  let bitmap;
  if ("createImageBitmap" in window) {
    bitmap = await createImageBitmap(file);
  } else {
    bitmap = await new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`No se puede abrir ${file.name}`)); };
      image.src = url;
    });
  }

  const sourceWidth = bitmap.width || bitmap.naturalWidth;
  const sourceHeight = bitmap.height || bitmap.naturalHeight;
  const upscale = sourceWidth < 1800 ? 1800 / sourceWidth : 1;
  const downscale = sourceWidth * upscale > 3200 ? 3200 / (sourceWidth * upscale) : 1;
  const scale = upscale * downscale;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scale));
  canvas.height = Math.max(1, Math.round(sourceHeight * scale));
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = image.data;
  const contrast = 1.18;
  for (let index = 0; index < data.length; index += 4) {
    const gray = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
    const adjusted = Math.max(0, Math.min(255, (gray - 128) * contrast + 128));
    data[index] = adjusted;
    data[index + 1] = adjusted;
    data[index + 2] = adjusted;
  }
  // Las líneas gruesas de las tablas suelen unir dos códigos en una sola palabra OCR.
  // Se eliminan únicamente trazos oscuros que atraviesan gran parte de la imagen.
  const darkAt = (x, y) => data[(y * canvas.width + x) * 4] < 72;
  const verticalLines = [];
  for (let x = 0; x < canvas.width; x += 1) {
    let dark = 0;
    for (let y = 0; y < canvas.height; y += 2) if (darkAt(x, y)) dark += 1;
    if (dark > canvas.height * 0.22) verticalLines.push(x);
  }
  const horizontalLines = [];
  for (let y = 0; y < canvas.height; y += 1) {
    let dark = 0;
    for (let x = 0; x < canvas.width; x += 2) if (darkAt(x, y)) dark += 1;
    if (dark > canvas.width * 0.22) horizontalLines.push(y);
  }
  const whiten = (x, y) => {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    const offset = (y * canvas.width + x) * 4;
    data[offset] = 255; data[offset + 1] = 255; data[offset + 2] = 255;
  };
  for (const x of verticalLines) {
    for (let y = 0; y < canvas.height; y += 1) {
      whiten(x - 1, y); whiten(x, y); whiten(x + 1, y);
    }
  }
  for (const y of horizontalLines) {
    for (let x = 0; x < canvas.width; x += 1) {
      whiten(x, y - 1); whiten(x, y); whiten(x, y + 1);
    }
  }
  context.putImageData(image, 0, 0);
  return canvas;
}

export async function renderImagePreview(file, targetCanvas, geometry) {
  const source = await fileToCanvas(file);
  const maxWidth = 1500;
  const scale = Math.min(1, maxWidth / source.width);
  targetCanvas.width = Math.round(source.width * scale);
  targetCanvas.height = Math.round(source.height * scale);
  const context = targetCanvas.getContext("2d", { alpha: false });
  context.drawImage(source, 0, 0, targetCanvas.width, targetCanvas.height);
  if (geometry?.sourceWidth && geometry?.sourceHeight) {
    const scaleX = targetCanvas.width / geometry.sourceWidth;
    const scaleY = targetCanvas.height / geometry.sourceHeight;
    context.fillStyle = "rgba(195, 25, 32, .12)";
    context.strokeStyle = "#c31920";
    context.lineWidth = 2;
    context.fillRect(geometry.x * scaleX, geometry.y * scaleY, geometry.width * scaleX, geometry.height * scaleY);
    context.strokeRect(geometry.x * scaleX, geometry.y * scaleY, geometry.width * scaleX, geometry.height * scaleY);
  }
}

export async function terminateOcr() {
  if (!workerPromise) return;
  const worker = await workerPromise;
  await worker.terminate();
  workerPromise = null;
}
