import { detectAssignments, normalizeService, validateRecord } from "./parser.js";
import { detectCircularAssignments, validateCircularRecord } from "./circular-parser.js";
import { classifyDocument, documentModeLabel, inferBookOffset } from "./document-detector.js";
import { getPdfTextPage, loadPdf, renderPdfPage, renderPdfPreview } from "./pdf-engine.js";
import { fileToCanvas, recognizeCanvas, renderImagePreview, terminateOcr } from "./ocr-engine.js";
import {
  analyzeCircularRecords, analyzeRecords, buildAudit, buildDatedSpecialJson, buildJson,
  datedBaseTurn, downloadJson, mergeSpecialJson, validateDatedSpecialJson, validateSpecialJson
} from "./exporter.js";

const DEFAULT_RANGES = [
  { start: 5, end: 102, serviceA: "0", serviceB: "100" },
  { start: 105, end: 158, serviceA: "400", serviceB: "500" },
  { start: 161, end: 222, serviceA: "200", serviceB: "300" },
  { start: 225, end: 294, serviceA: "800", serviceB: "900" }
];

const state = {
  files: [], pdfs: new Map(), records: [], specialBase: null, specialBaseFilename: "",
  running: false, cancelRequested: false, rangeMode: "pdf", effectiveMode: "", detectionCache: new Map()
};

const elements = Object.fromEntries([
  "file-input", "file-summary", "file-help", "dropzone", "page-offset", "range-body", "range-row-template",
  "add-range", "analyze", "cancel", "progress-wrap", "progress-label", "progress-percent", "progress-bar",
  "notice", "review-section", "review-body", "review-head", "stats", "search", "issues-only", "add-record",
  "empty-review", "export-status", "export-regular", "export-special", "export-audit", "source-dialog",
  "dialog-title", "dialog-caption", "source-canvas", "close-dialog", "book-config", "circular-config",
  "fallback-date", "special-base-input", "special-base-summary", "clear-special-base", "special-conflict-policy",
  "special-merge-title", "special-merge-description"
].map(id => [id, document.getElementById(id)]));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
}

function selectedDocMode() {
  return document.querySelector('input[name="document-type"]:checked').value;
}

function activeMode() {
  const selected = selectedDocMode();
  return selected === "auto" ? state.effectiveMode : selected;
}

function selectedEngine() {
  return document.querySelector('input[name="engine"]:checked').value;
}

function setNotice(message, type = "info") {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("hidden", !message);
  elements.notice.classList.toggle("error", type === "error");
}

function setProgress(value, label) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  elements["progress-label"].textContent = label;
  elements["progress-percent"].textContent = `${percent}%`;
  elements["progress-bar"].style.width = `${percent}%`;
}

function isPdf(file) {
  return file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf");
}

function addRangeRow(range = { start: 1, end: 1, serviceA: "0", serviceB: "100" }) {
  const row = elements["range-row-template"].content.firstElementChild.cloneNode(true);
  row.querySelector(".range-start").value = range.start;
  row.querySelector(".range-end").value = range.end;
  row.querySelector(".service-a").value = range.serviceA;
  row.querySelector(".service-b").value = range.serviceB;
  row.querySelector(".remove-range").addEventListener("click", () => row.remove());
  elements["range-body"].append(row);
}

function setRanges(ranges) {
  elements["range-body"].replaceChildren();
  ranges.forEach(addRangeRow);
}

function collectRanges() {
  const ranges = [];
  for (const row of elements["range-body"].rows) {
    const start = Number(row.querySelector(".range-start").value);
    const end = Number(row.querySelector(".range-end").value);
    const serviceA = normalizeService(row.querySelector(".service-a").value);
    const rawB = row.querySelector(".service-b").value.trim();
    const serviceB = rawB ? normalizeService(rawB) : "";
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("Revisa las páginas inicial y final de los bloques.");
    }
    if (serviceA === null || (rawB && serviceB === null)) throw new Error("Los servicios deben ser códigos numéricos de hasta tres cifras.");
    if (serviceA === serviceB) throw new Error("Un bloque no puede repetir el mismo servicio.");
    ranges.push({ start, end, serviceA, serviceB });
  }
  if (!ranges.length) throw new Error("Añade al menos un bloque de servicio.");
  return ranges;
}

function resetSpecialBase() {
  state.specialBase = null;
  state.specialBaseFilename = "";
  elements["special-base-input"].value = "";
  elements["special-base-summary"].textContent = "Sin archivo base · se creará uno nuevo";
  elements["clear-special-base"].classList.add("hidden");
}

function presentMode(mode = activeMode()) {
  const selected = selectedDocMode();
  const automatic = selected === "auto";
  const circular = mode === "circular";
  document.body.dataset.selectionMode = selected;
  document.body.dataset.documentMode = mode || "auto";
  elements["book-config"].classList.toggle("hidden", mode !== "book" || automatic);
  elements["circular-config"].classList.toggle("hidden", mode === "book");
  elements["export-regular"].classList.toggle("hidden", mode !== "book");
  elements["file-help"].textContent = automatic
    ? "Selecciona un PDF o varias circulares PDF. La aplicación identificará el tipo automáticamente."
    : circular
      ? "Puedes seleccionar una o varias circulares PDF. Se analizarán todas sus páginas."
      : "Un PDF del libro o varias imágenes ordenadas.";
  elements["special-merge-title"].textContent = circular ? "Actualizar JSON especial anual" : "Actualizar servicios especiales";
  elements["special-merge-description"].textContent = circular
    ? "Carga el JSON anual actual. Las nuevas fechas y circulaciones se añadirán sin borrar las anteriores."
    : "Carga el JSON actual para conservarlo y añadir las nuevas asignaciones.";
}

function updateMode() {
  state.effectiveMode = selectedDocMode() === "auto" ? "" : selectedDocMode();
  presentMode();
  state.records = [];
  state.pdfs.clear();
  state.detectionCache.clear();
  resetSpecialBase();
  elements["review-section"].classList.add("hidden");
  if (state.files.length) updateFileSelection(state.files);
}

function updateFileSelection(fileList) {
  const selected = [...fileList];
  const pdfs = selected.filter(isPdf);
  const images = selected.filter(file => !isPdf(file));
  const selectionMode = selectedDocMode();
  const circular = selectionMode === "circular";
  const invalidMix = pdfs.length && images.length;
  const tooManyPdfs = selectionMode === "book" && pdfs.length > 1;
  if (invalidMix || tooManyPdfs) {
    state.files = [];
    elements["file-input"].value = "";
    elements["file-summary"].textContent = "Ningún archivo seleccionado";
    elements.analyze.disabled = true;
    setNotice(selectionMode === "book" ? "Selecciona un único PDF o un conjunto de imágenes." : "Selecciona uno o varios PDF, o un conjunto de imágenes, sin mezclar ambos formatos.", "error");
    return;
  }
  state.files = selected;
  state.pdfs.clear();
  state.detectionCache.clear();
  state.effectiveMode = selectionMode === "auto" ? "" : selectionMode;
  presentMode();
  state.records = [];
  elements.analyze.disabled = !selected.length;
  const kind = pdfs.length ? "PDF" : "imagen";
  elements["file-summary"].textContent = !selected.length ? "Ningún archivo seleccionado"
    : selected.length === 1 ? selected[0].name : `${selected.length} ${kind}${selected.length === 1 ? "" : "s"} seleccionados`;
  setNotice("");
  elements["review-section"].classList.add("hidden");

  if (selectionMode === "book") {
    const newMode = pdfs.length ? "pdf" : "images";
    if (newMode !== state.rangeMode) {
      state.rangeMode = newMode;
      if (newMode === "images") {
        elements["page-offset"].value = 0;
        setRanges([{ start: 1, end: Math.max(1, selected.length), serviceA: "0", serviceB: "100" }]);
      } else {
        elements["page-offset"].value = 0;
        setRanges(DEFAULT_RANGES);
      }
    } else if (newMode === "images" && elements["range-body"].rows.length === 1) {
      elements["range-body"].rows[0].querySelector(".range-end").value = Math.max(1, selected.length);
    }
  }
}

function sourceInfo(task, engine, width, height) {
  const file = state.files[task.fileIndex];
  return {
    sourceId: `${task.kind}-${task.fileIndex}`,
    sourceName: file.name,
    sourceKind: task.kind,
    fileIndex: task.fileIndex,
    pageLabel: task.printedPage,
    physicalPage: task.physicalPage,
    engine,
    sourceWidth: width,
    sourceHeight: height
  };
}

function ocrStatus(message) {
  const names = {
    "loading tesseract core": "Cargando motor OCR", "initializing tesseract": "Inicializando OCR",
    "loading language traineddata": "Cargando modelo de lectura", "initializing api": "Preparando reconocimiento",
    "recognizing text": "Reconociendo texto"
  };
  return names[message.status] || "Procesando imagen";
}

async function tokensForPdfPage(pdf, task, progress, keepForAnalysis = false) {
  const cacheKey = `pdf-${task.fileIndex}-${task.physicalPage}`;
  if (state.detectionCache.has(cacheKey)) {
    const cached = state.detectionCache.get(cacheKey);
    state.detectionCache.delete(cacheKey);
    return cached;
  }
  let result;
  if (selectedEngine() !== "ocr") {
    const textPage = await getPdfTextPage(pdf, task.physicalPage);
    if (selectedEngine() === "text" || textPage.meaningfulTextItems >= 15) {
      result = { tokens: textPage.tokens, engine: "texto", width: textPage.viewport.width, height: textPage.viewport.height };
    }
  }
  if (!result) {
    const canvas = await renderPdfPage(pdf, task.physicalPage);
    const ocr = await recognizeCanvas(canvas, progress);
    result = { tokens: ocr.tokens, engine: "ocr", width: ocr.width, height: ocr.height };
  }
  if (keepForAnalysis) state.detectionCache.set(cacheKey, result);
  return result;
}

async function tokensForImage(fileIndex, progress, keepForAnalysis = false) {
  const cacheKey = `image-${fileIndex}`;
  if (state.detectionCache.has(cacheKey)) {
    const cached = state.detectionCache.get(cacheKey);
    state.detectionCache.delete(cacheKey);
    return cached;
  }
  const canvas = await fileToCanvas(state.files[fileIndex]);
  const ocr = await recognizeCanvas(canvas, progress);
  const result = { tokens: ocr.tokens, engine: "ocr", width: ocr.width, height: ocr.height };
  if (keepForAnalysis) state.detectionCache.set(cacheKey, result);
  return result;
}

async function detectAutomaticMode() {
  const pdfMode = isPdf(state.files[0]);
  if (selectedEngine() === "text" && !pdfMode) throw new Error("El motor de texto sólo puede utilizarse con PDF.");
  const findings = [];

  if (pdfMode) {
    for (let fileIndex = 0; fileIndex < state.files.length; fileIndex += 1) {
      const pdf = state.pdfs.get(fileIndex) || await loadPdf(state.files[fileIndex]);
      state.pdfs.set(fileIndex, pdf);
      const pages = [];
      const samplePages = [1, 2, 3, 4].filter(page => page <= pdf.numPages);
      for (let index = 0; index < samplePages.length; index += 1) {
        const pageNumber = samplePages[index];
        const task = { kind: "pdf", fileIndex, printedPage: pageNumber, physicalPage: pageNumber };
        const data = await tokensForPdfPage(pdf, task, message => setProgress(
          (fileIndex + (index + (message.progress || 0)) / samplePages.length) / state.files.length * 0.08,
          `${ocrStatus(message)} · identificando ${state.files[fileIndex].name}`
        ), true);
        pages.push({ tokens: data.tokens });
      }
      findings.push({ file: state.files[fileIndex].name, ...classifyDocument(pages, { fileName: state.files[fileIndex].name, pageCount: pdf.numPages }) });
    }
  } else {
    const pages = [];
    const sampleCount = Math.min(3, state.files.length);
    for (let fileIndex = 0; fileIndex < sampleCount; fileIndex += 1) {
      const data = await tokensForImage(fileIndex, message => setProgress(
        (fileIndex + (message.progress || 0)) / sampleCount * 0.08,
        `${ocrStatus(message)} · identificando imagen ${fileIndex + 1}`
      ), true);
      pages.push({ tokens: data.tokens });
    }
    findings.push({ file: `${state.files.length} imagen${state.files.length === 1 ? "" : "es"}`, ...classifyDocument(pages, { pageCount: state.files.length }) });
  }

  const unresolved = findings.filter(item => !item.mode);
  if (unresolved.length) {
    throw new Error(`No se ha podido identificar automáticamente ${unresolved.map(item => item.file).join(", ")}. Selecciona Circular de servicio o Libro de itinerarios.`);
  }
  const modes = [...new Set(findings.map(item => item.mode))];
  if (modes.length > 1) throw new Error("La selección mezcla circulares y libros. Analiza cada tipo por separado.");
  if (modes[0] === "book" && state.files.length > 1) throw new Error("Los libros de itinerarios deben analizarse de uno en uno.");

  state.effectiveMode = modes[0];
  if (state.effectiveMode === "book") {
    const inferredOffset = pdfMode ? inferBookOffset(state.pdfs.get(0)?.numPages) : 0;
    elements["page-offset"].value = inferredOffset;
    findings[0].bookOffset = inferredOffset;
    state.rangeMode = pdfMode ? "pdf" : "images";
    setRanges(pdfMode ? DEFAULT_RANGES : [{ start: 1, end: state.files.length, serviceA: "0", serviceB: "100" }]);
  }
  presentMode(state.effectiveMode);
  return findings;
}

function bookPdfTasks(pdf, ranges) {
  const offset = Number(elements["page-offset"].value) || 0;
  const tasks = [];
  const seen = new Set();
  for (const range of ranges) {
    for (let printedPage = range.start; printedPage <= range.end; printedPage += 1) {
      const physicalPage = printedPage + offset;
      if (physicalPage < 1 || physicalPage > pdf.numPages) throw new Error(`La página impresa ${printedPage} queda fuera del PDF con el desfase indicado.`);
      const key = `${physicalPage}|${range.serviceA}|${range.serviceB}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ kind: "pdf", fileIndex: 0, printedPage, physicalPage, services: [range.serviceA, range.serviceB].filter(Boolean) });
    }
  }
  return tasks;
}

function bookImageTasks(ranges) {
  return state.files.map((file, index) => {
    const page = index + 1;
    const range = ranges.find(item => page >= item.start && page <= item.end);
    if (!range) throw new Error(`La imagen ${page} no pertenece a ningún bloque de servicio.`);
    return { kind: "image", fileIndex: index, printedPage: page, physicalPage: page, services: [range.serviceA, range.serviceB].filter(Boolean) };
  });
}

async function analyzeBook() {
  const ranges = collectRanges();
  const pdfMode = isPdf(state.files[0]);
  if (selectedEngine() === "text" && !pdfMode) throw new Error("El motor de texto sólo puede utilizarse con PDF.");
  if (pdfMode && !state.pdfs.has(0)) state.pdfs.set(0, await loadPdf(state.files[0]));
  const tasks = pdfMode ? bookPdfTasks(state.pdfs.get(0), ranges) : bookImageTasks(ranges);
  for (let index = 0; index < tasks.length && !state.cancelRequested; index += 1) {
    const task = tasks[index];
    const base = index / tasks.length;
    const description = task.kind === "pdf" ? `página ${task.printedPage}` : `imagen ${task.printedPage}`;
    let data;
    if (task.kind === "pdf") {
      data = await tokensForPdfPage(state.pdfs.get(0), task, message => setProgress(base + (message.progress || 0) / tasks.length, `${ocrStatus(message)} · ${description}`));
    } else {
      data = await tokensForImage(task.fileIndex, message => setProgress(base + (message.progress || 0) / tasks.length, `${ocrStatus(message)} · ${description}`));
    }
    const source = sourceInfo(task, data.engine, data.width, data.height);
    state.records.push(...detectAssignments(data.tokens, task.services, source));
    setProgress((index + 1) / tasks.length, `Analizada ${description}`);
  }
}

function fallbackDate() {
  const value = elements["fallback-date"].value;
  if (!value) return "";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

async function analyzeCirculars() {
  const pdfFiles = state.files.filter(isPdf);
  if (selectedEngine() === "text" && !pdfFiles.length) throw new Error("El motor de texto sólo puede utilizarse con PDF.");
  const documents = [];
  let totalPages = state.files.length;
  if (pdfFiles.length) {
    totalPages = 0;
    for (let index = 0; index < state.files.length; index += 1) {
      const pdf = state.pdfs.get(index) || await loadPdf(state.files[index]);
      state.pdfs.set(index, pdf);
      totalPages += pdf.numPages;
    }
  }
  let completed = 0;
  if (pdfFiles.length) {
    for (let fileIndex = 0; fileIndex < state.files.length && !state.cancelRequested; fileIndex += 1) {
      const pdf = state.pdfs.get(fileIndex);
      const pages = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages && !state.cancelRequested; pageNumber += 1) {
        const task = { kind: "pdf", fileIndex, printedPage: pageNumber, physicalPage: pageNumber };
        const base = completed / totalPages;
        const label = `${state.files[fileIndex].name} · página ${pageNumber}`;
        const data = await tokensForPdfPage(pdf, task, message => setProgress(base + (message.progress || 0) / totalPages, `${ocrStatus(message)} · ${label}`));
        pages.push({ tokens: data.tokens, ...sourceInfo(task, data.engine, data.width, data.height) });
        completed += 1;
        setProgress(completed / totalPages, `Leyendo ${label}`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      documents.push(pages);
    }
  } else {
    const pages = [];
    for (let fileIndex = 0; fileIndex < state.files.length && !state.cancelRequested; fileIndex += 1) {
      const base = completed / totalPages;
      const ocr = await tokensForImage(fileIndex, message => setProgress(base + (message.progress || 0) / totalPages, `${ocrStatus(message)} · imagen ${fileIndex + 1}`));
      const task = { kind: "image", fileIndex, printedPage: fileIndex + 1, physicalPage: fileIndex + 1 };
      pages.push({ tokens: ocr.tokens, ...sourceInfo(task, "ocr", ocr.width, ocr.height) });
      completed += 1;
    }
    documents.push(pages);
  }
  state.records = detectCircularAssignments(documents, fallbackDate());
}

async function analyze() {
  if (state.running || !state.files.length) return;
  state.running = true;
  state.cancelRequested = false;
  state.records = [];
  state.pdfs.clear();
  state.detectionCache.clear();
  if (selectedDocMode() === "auto") state.effectiveMode = "";
  setNotice("");
  elements.analyze.disabled = true;
  elements.cancel.disabled = false;
  elements.cancel.classList.remove("hidden");
  elements["progress-wrap"].classList.remove("hidden");
  elements["review-section"].classList.add("hidden");
  setProgress(0, "Preparando documentos");
  try {
    let automaticLabel = "";
    if (selectedDocMode() === "auto") {
      const findings = await detectAutomaticMode();
      automaticLabel = `Detectado: ${documentModeLabel(state.effectiveMode)}`;
      const evidence = [...new Set(findings.flatMap(item => item.evidence))].slice(0, 2);
      if (evidence.length) automaticLabel += ` (${evidence.join(" · ")})`;
      if (state.effectiveMode === "book") automaticLabel += ` · desfase ${findings[0].bookOffset}`;
    }
    if (activeMode() === "circular") await analyzeCirculars(); else await analyzeBook();
    await terminateOcr().catch(() => {});
    if (state.cancelRequested) setNotice(`Proceso detenido. Se conservan ${state.records.length} filas ya extraídas.`);
    else if (!state.records.length) setNotice("No se han detectado asignaciones válidas. Revisa el tipo de documento, el motor y la calidad del original.", "error");
    else setNotice(`${automaticLabel ? `${automaticLabel}. ` : ""}Extracción terminada: ${state.records.length} asignaciones preparadas para revisión.`);
    renderReview();
  } catch (error) {
    await terminateOcr().catch(() => {});
    setNotice(error?.message || "No se ha podido analizar el documento.", "error");
  } finally {
    state.running = false;
    elements.analyze.disabled = !state.files.length;
    elements.cancel.disabled = false;
    elements.cancel.classList.add("hidden");
    setProgress(1, state.cancelRequested ? "Detenido" : "Finalizado");
  }
}

function dynamicIssues() {
  const circular = activeMode() === "circular";
  const analysis = circular ? analyzeCircularRecords(state.records) : analyzeRecords(state.records);
  const conflictsByRecord = new Map();
  for (const conflict of analysis.conflicts) {
    for (const id of conflict.records) {
      if (!conflictsByRecord.has(id)) conflictsByRecord.set(id, []);
      const key = circular ? `${conflict.date}/${conflict.circulation}` : `${conflict.service}/${conflict.circulation}`;
      conflictsByRecord.get(id).push(`Conflicto ${key}: ${conflict.turns.join(" · ")}`);
    }
  }
  const baseConflicts = [];
  if (state.specialBase && elements["special-conflict-policy"].value === "review") {
    for (const item of analysis.expanded) {
      const existingTurn = circular
        ? datedBaseTurn(state.specialBase, item.date, item.circulation)
        : (/^[67]\d{2}$/.test(item.service.padStart(3, "0")) ? state.specialBase.services?.[item.service]?.[item.circulation] : "");
      if (existingTurn && existingTurn !== item.turn) {
        baseConflicts.push({ ...item, existingTurn });
        if (!conflictsByRecord.has(item.record.id)) conflictsByRecord.set(item.record.id, []);
        conflictsByRecord.get(item.record.id).push(`El JSON actual contiene ${circular ? item.date : item.service}/${item.circulation} → ${existingTurn}`);
      }
    }
  }
  return { analysis, conflictsByRecord, baseConflicts };
}

function rowIssues(record, conflictsByRecord) {
  const validation = record.kind === "circular" ? validateCircularRecord(record) : validateRecord(record);
  return [...(record.issues || []), ...validation.issues, ...(conflictsByRecord.get(record.id) || [])];
}

function renderReview() {
  const circular = activeMode() === "circular";
  elements["review-section"].classList.remove("hidden");
  const { analysis, conflictsByRecord, baseConflicts } = dynamicIssues();
  const issueRows = state.records.filter(record => rowIssues(record, conflictsByRecord).length).length;
  if (circular) {
    const dates = new Set(analysis.expanded.map(item => item.date));
    elements.stats.innerHTML = [
      [state.records.length, "Asignaciones", ""], [dates.size, "Fechas", ""],
      [state.records.filter(record => record.extractionFormat === "fila-torn").length, "Desde fila TORN", ""],
      [issueRows, "Con incidencias", issueRows ? "alert" : ""]
    ].map(([value, label, style]) => `<div class="stat ${style}"><strong>${value}</strong><span>${label}</span></div>`).join("");
    elements["review-head"].innerHTML = "<tr><th>Origen</th><th>Fecha operativa</th><th>Turno</th><th>Circulación</th><th>Lectura</th><th></th></tr>";
  } else {
    const specials = analysis.expanded.filter(item => /^[67]\d{2}$/.test(item.service.padStart(3, "0"))).length;
    elements.stats.innerHTML = [
      [state.records.length, "Filas detectadas", ""], [analysis.expanded.length, "Asignaciones", ""],
      [specials, "Especiales", ""], [issueRows, "Con incidencias", issueRows ? "alert" : ""]
    ].map(([value, label, style]) => `<div class="stat ${style}"><strong>${value}</strong><span>${label}</span></div>`).join("");
    elements["review-head"].innerHTML = "<tr><th>Origen</th><th>Servicio A</th><th>Turno A</th><th>Servicio B</th><th>Turno B</th><th>Circulación</th><th>Lectura</th><th></th></tr>";
  }

  const query = elements.search.value.trim().toUpperCase();
  const onlyIssues = elements["issues-only"].checked;
  const filtered = state.records.filter(record => {
    const issues = rowIssues(record, conflictsByRecord);
    const haystack = [record.sourceName, record.pageLabel, record.date, record.baseService, record.serviceA, record.serviceB, record.turn, record.turnA, record.turnB, record.circulation, record.rawTurn].join(" ").toUpperCase();
    return (!query || haystack.includes(query)) && (!onlyIssues || issues.length);
  });

  elements["review-body"].innerHTML = filtered.map(record => {
    const issues = rowIssues(record, conflictsByRecord);
    const confidenceClass = record.confidence < 70 ? "bad" : record.confidence < 85 ? "warn" : "";
    const engineLabel = record.engine === "ocr" ? `OCR ${record.confidence}%` : record.engine === "manual" ? "Manual" : "Texto PDF";
    const source = `<td class="source-cell"><strong>${escapeHtml(record.sourceName)}</strong><br>Pág. ${escapeHtml(record.pageLabel)}${record.sourceKind === "manual" ? "" : `<button type="button" data-action="preview">Ver origen</button>`}</td>`;
    const reading = `<td class="confidence"><strong class="${confidenceClass}">${engineLabel}</strong><small>${escapeHtml(issues.join(" · ") || record.rawTurn || "Validado")}</small></td>`;
    const remove = `<td><button class="icon-button" type="button" data-action="delete" aria-label="Eliminar fila">×</button></td>`;
    if (circular) {
      return `<tr data-id="${record.id}" class="${issues.length ? "has-issue" : ""}">${source}
        <td><input data-field="date" maxlength="10" value="${escapeHtml(record.date)}" aria-label="Fecha operativa"></td>
        <td><input data-field="turn" maxlength="3" value="${escapeHtml(record.turn)}" aria-label="Turno"></td>
        <td><input data-field="circulation" maxlength="4" value="${escapeHtml(record.circulation)}" aria-label="Circulación"></td>
        ${reading}${remove}</tr>`;
    }
    return `<tr data-id="${record.id}" class="${issues.length ? "has-issue" : ""}">${source}
      <td><input data-field="serviceA" maxlength="3" inputmode="numeric" value="${escapeHtml(record.serviceA)}"></td>
      <td><input data-field="turnA" maxlength="3" value="${escapeHtml(record.turnA)}"></td>
      <td><input data-field="serviceB" maxlength="3" inputmode="numeric" value="${escapeHtml(record.serviceB)}"></td>
      <td><input data-field="turnB" maxlength="3" value="${escapeHtml(record.turnB)}"></td>
      <td><input data-field="circulation" maxlength="4" value="${escapeHtml(record.circulation)}"></td>
      ${reading}${remove}</tr>`;
  }).join("");
  elements["empty-review"].classList.toggle("hidden", filtered.length > 0);
  const blocking = analysis.invalid.length + analysis.conflicts.length + baseConflicts.length;
  elements["export-status"].textContent = blocking
    ? `${blocking} incidencia${blocking === 1 ? "" : "s"} bloquean la exportación afectada.`
    : "Datos válidos. El JSON puede generarse.";
}

function addManualRecord() {
  if (activeMode() === "circular") {
    state.records.unshift({
      id: crypto.randomUUID(), kind: "circular", sourceId: "manual", sourceName: "Entrada manual", sourceKind: "manual",
      fileIndex: -1, pageLabel: "—", physicalPage: null, engine: "manual", date: fallbackDate(), baseService: "",
      turn: "", circulation: "", rawTurn: "", extractionFormat: "manual", confidence: 100, issues: [], geometry: null
    });
  } else {
    let range;
    try { range = collectRanges()[0]; } catch { range = { serviceA: "0", serviceB: "100" }; }
    state.records.unshift({
      id: crypto.randomUUID(), sourceId: "manual", sourceName: "Entrada manual", sourceKind: "manual", fileIndex: -1,
      pageLabel: "—", physicalPage: null, engine: "manual", serviceA: range.serviceA, serviceB: range.serviceB,
      turnA: "", turnB: "", circulation: "", rawTurn: "", confidence: 100, issues: [], geometry: null
    });
  }
  renderReview();
  elements["review-body"].querySelector("input[data-field='turn'], input[data-field='turnA']")?.focus();
}

async function showSource(record) {
  elements["dialog-title"].textContent = `${record.sourceName} · página ${record.pageLabel}`;
  elements["dialog-caption"].textContent = record.rawTurn ? `Lectura: ${record.rawTurn.replace(/\n/g, " · ")}` : "No se obtuvo una lectura original.";
  const canvas = elements["source-canvas"];
  const context = canvas.getContext("2d");
  canvas.width = 640; canvas.height = 320;
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#666"; context.font = "16px sans-serif"; context.fillText("Preparando vista…", 24, 42);
  elements["source-dialog"].showModal();
  try {
    if (record.sourceKind === "pdf") await renderPdfPreview(state.pdfs.get(record.fileIndex), record.physicalPage, canvas, record.geometry);
    else await renderImagePreview(state.files[record.fileIndex], canvas, record.geometry);
  } catch {
    elements["dialog-caption"].textContent = "No se ha podido generar la vista del origen.";
  }
}

async function exportKind(kind) {
  if (activeMode() === "circular") {
    const result = buildDatedSpecialJson(state.records, state.specialBase, elements["special-conflict-policy"].value);
    const blocking = result.invalid.length + result.internalConflicts.length + result.errors.length
      + (elements["special-conflict-policy"].value === "review" ? result.conflicts.length : 0);
    if (blocking) {
      elements["issues-only"].checked = true;
      renderReview();
      setNotice(result.errors[0] || `Corrige las incidencias o decide qué versión debe prevalecer en ${result.conflicts.length} conflicto${result.conflicts.length === 1 ? "" : "s"}.`, "error");
      elements["review-section"].scrollIntoView({ behavior: "smooth" });
      return;
    }
    const filename = state.specialBaseFilename || `sim_turnos_especiales_${result.payload.year}.json`;
    const hash = await downloadJson(filename, result.payload);
    setNotice(`${filename} actualizado sin borrar fechas anteriores. SHA-256: ${hash}`);
    return;
  }

  const result = buildJson(state.records, kind);
  if (result.invalid.length || result.conflicts.length) {
    elements["issues-only"].checked = true;
    renderReview();
    setNotice("Corrige las filas no válidas o los conflictos antes de exportar.", "error");
    return;
  }
  const filename = kind === "special" ? "sim_turnos_especiales.json" : "sim_turnos_servicios.json";
  let payload = result.payload;
  if (kind === "special" && state.specialBase) {
    const merged = mergeSpecialJson(payload, state.specialBase.services, elements["special-conflict-policy"].value, state.specialBase.template);
    if (merged.conflicts.length && elements["special-conflict-policy"].value === "review") {
      setNotice(`Hay ${merged.conflicts.length} conflictos con el JSON actual. Elige qué versión debe prevalecer.`, "error");
      return;
    }
    payload = merged.payload;
  }
  const hash = await downloadJson(filename, payload);
  setNotice(`${filename} generado. SHA-256: ${hash}`);
}

async function loadSpecialBase(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (activeMode() === "circular") {
      state.specialBase = validateDatedSpecialJson(parsed);
      elements["special-base-summary"].textContent = `${file.name} · ${state.specialBase.dateCount} fechas · ${state.specialBase.assignments} asignaciones conservadas`;
    } else {
      state.specialBase = validateSpecialJson(parsed);
      elements["special-base-summary"].textContent = `${file.name} · ${state.specialBase.serviceCount} servicios · ${state.specialBase.assignments} asignaciones conservadas`;
    }
    state.specialBaseFilename = file.name;
    elements["clear-special-base"].classList.remove("hidden");
    setNotice("JSON cargado. La exportación conservará todas sus asignaciones anteriores.");
    if (state.records.length) renderReview();
  } catch (error) {
    resetSpecialBase();
    setNotice(error?.message || "No se ha podido leer el JSON actual.", "error");
  }
}

elements["file-input"].addEventListener("change", event => updateFileSelection(event.target.files));
elements.dropzone.addEventListener("dragover", event => { event.preventDefault(); elements.dropzone.classList.add("dragging"); });
elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("dragging"));
elements.dropzone.addEventListener("drop", event => { event.preventDefault(); elements.dropzone.classList.remove("dragging"); updateFileSelection(event.dataTransfer.files); });
document.querySelectorAll('input[name="document-type"]').forEach(input => input.addEventListener("change", updateMode));
elements["add-range"].addEventListener("click", () => addRangeRow());
elements.analyze.addEventListener("click", analyze);
elements.cancel.addEventListener("click", () => { state.cancelRequested = true; elements.cancel.disabled = true; setNotice("Se detendrá al terminar la página actual."); });
elements.search.addEventListener("input", renderReview);
elements["issues-only"].addEventListener("change", renderReview);
elements["add-record"].addEventListener("click", addManualRecord);
elements["review-body"].addEventListener("change", event => {
  const row = event.target.closest("tr[data-id]");
  const field = event.target.dataset.field;
  if (!row || !field) return;
  const record = state.records.find(item => item.id === row.dataset.id);
  if (!record) return;
  record[field] = event.target.value.trim().toUpperCase();
  renderReview();
});
elements["review-body"].addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  const row = event.target.closest("tr[data-id]");
  if (!button || !row) return;
  const record = state.records.find(item => item.id === row.dataset.id);
  if (!record) return;
  if (button.dataset.action === "delete") { state.records = state.records.filter(item => item.id !== record.id); renderReview(); }
  else if (button.dataset.action === "preview") showSource(record);
});
elements["export-regular"].addEventListener("click", () => exportKind("regular"));
elements["export-special"].addEventListener("click", () => exportKind("special"));
elements["special-base-input"].addEventListener("change", event => { const [file] = event.target.files; if (file) loadSpecialBase(file); });
elements["clear-special-base"].addEventListener("click", () => {
  resetSpecialBase();
  setNotice("Archivo base retirado. Se generará un JSON nuevo sólo con los datos revisados.");
  if (state.records.length) renderReview();
});
elements["special-conflict-policy"].addEventListener("change", () => { if (state.records.length) renderReview(); });
elements["export-audit"].addEventListener("click", async () => {
  const hash = await downloadJson("sim_turnos_auditoria.json", buildAudit(state.records, state.files));
  setNotice(`sim_turnos_auditoria.json generado. SHA-256: ${hash}`);
});
elements["close-dialog"].addEventListener("click", () => elements["source-dialog"].close());
elements["source-dialog"].addEventListener("click", event => { if (event.target === elements["source-dialog"]) elements["source-dialog"].close(); });

setRanges(DEFAULT_RANGES);
updateMode();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("./service-worker.js").catch(() => {});
