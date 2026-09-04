import { detectAssignments, normalizeService, validateRecord } from "./parser.js";
import { getPdfTextPage, loadPdf, renderPdfPage, renderPdfPreview } from "./pdf-engine.js";
import { fileToCanvas, recognizeCanvas, renderImagePreview, terminateOcr } from "./ocr-engine.js";
import { analyzeRecords, buildAudit, buildJson, downloadJson, mergeSpecialJson, validateSpecialJson } from "./exporter.js";

const DEFAULT_RANGES = [
  { start: 5, end: 102, serviceA: "0", serviceB: "100" },
  { start: 105, end: 158, serviceA: "400", serviceB: "500" },
  { start: 161, end: 222, serviceA: "200", serviceB: "300" },
  { start: 225, end: 294, serviceA: "800", serviceB: "900" }
];

const state = {
  files: [],
  pdf: null,
  records: [],
  specialBase: null,
  running: false,
  cancelRequested: false,
  rangeMode: "pdf"
};

const elements = Object.fromEntries([
  "file-input", "file-summary", "dropzone", "page-offset", "range-body", "range-row-template",
  "add-range", "analyze", "cancel", "progress-wrap", "progress-label", "progress-percent",
  "progress-bar", "notice", "review-section", "review-body", "stats", "search", "issues-only",
  "add-record", "empty-review", "export-status", "export-regular", "export-special", "export-audit",
  "source-dialog", "dialog-title", "dialog-caption", "source-canvas", "close-dialog",
  "special-base-input", "special-base-summary", "clear-special-base", "special-conflict-policy"
].map(id => [id, document.getElementById(id)]));

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[char]));
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
    if (serviceA === null || (rawB && serviceB === null)) {
      throw new Error("Los servicios deben ser códigos numéricos de hasta tres cifras.");
    }
    if (serviceA === serviceB) throw new Error("Un bloque no puede repetir el mismo servicio.");
    ranges.push({ start, end, serviceA, serviceB });
  }
  if (!ranges.length) throw new Error("Añade al menos un bloque de servicio.");
  return ranges;
}

function rangeForPage(pageLabel, ranges) {
  return ranges.find(range => pageLabel >= range.start && pageLabel <= range.end) || null;
}

function selectedEngine() {
  return document.querySelector('input[name="engine"]:checked').value;
}

function isPdf(file) {
  return file?.type === "application/pdf" || file?.name.toLowerCase().endsWith(".pdf");
}

function updateFileSelection(files) {
  const selected = [...files];
  const pdfs = selected.filter(isPdf);
  const images = selected.filter(file => !isPdf(file));
  if ((pdfs.length && images.length) || pdfs.length > 1) {
    state.files = [];
    elements["file-input"].value = "";
    elements["file-summary"].textContent = "Ningún archivo seleccionado";
    elements.analyze.disabled = true;
    setNotice("Selecciona un único PDF o un conjunto de imágenes, sin mezclarlos.", "error");
    return;
  }
  state.files = selected;
  state.pdf = null;
  state.records = [];
  elements.analyze.disabled = !selected.length;
  elements["file-summary"].textContent = selected.length === 1 ? selected[0].name : `${selected.length} imágenes seleccionadas`;
  setNotice("");
  elements["review-section"].classList.add("hidden");

  const newMode = pdfs.length ? "pdf" : "images";
  if (newMode !== state.rangeMode) {
    state.rangeMode = newMode;
    if (newMode === "images") {
      elements["page-offset"].value = 0;
      setRanges([{ start: 1, end: Math.max(1, selected.length), serviceA: "0", serviceB: "100" }]);
    } else {
      elements["page-offset"].value = 24;
      setRanges(DEFAULT_RANGES);
    }
  } else if (newMode === "images" && elements["range-body"].rows.length === 1) {
    elements["range-body"].rows[0].querySelector(".range-end").value = Math.max(1, selected.length);
  }
}

function pdfTasks(pdf, ranges) {
  const offset = Number(elements["page-offset"].value) || 0;
  const tasks = [];
  const seen = new Set();
  for (const range of ranges) {
    for (let printedPage = range.start; printedPage <= range.end; printedPage += 1) {
      const physicalPage = printedPage + offset;
      if (physicalPage < 1 || physicalPage > pdf.numPages) {
        throw new Error(`La página impresa ${printedPage} corresponde a la página física ${physicalPage}, fuera del PDF.`);
      }
      const key = `${physicalPage}|${range.serviceA}|${range.serviceB}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({
        kind: "pdf",
        fileIndex: 0,
        printedPage,
        physicalPage,
        services: [range.serviceA, range.serviceB].filter(Boolean)
      });
    }
  }
  return tasks;
}

function imageTasks(ranges) {
  return state.files.map((file, index) => {
    const pageLabel = index + 1;
    const range = rangeForPage(pageLabel, ranges);
    if (!range) throw new Error(`La imagen ${pageLabel} no pertenece a ningún bloque de servicio.`);
    return {
      kind: "image",
      fileIndex: index,
      printedPage: pageLabel,
      physicalPage: pageLabel,
      services: [range.serviceA, range.serviceB].filter(Boolean)
    };
  });
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
    "loading tesseract core": "Cargando motor OCR",
    "initializing tesseract": "Inicializando OCR",
    "loading language traineddata": "Cargando modelo de lectura",
    "initializing api": "Preparando reconocimiento",
    "recognizing text": "Reconociendo texto"
  };
  return names[message.status] || "Procesando imagen";
}

async function analyze() {
  if (state.running || !state.files.length) return;
  state.running = true;
  state.cancelRequested = false;
  state.records = [];
  setNotice("");
  elements.analyze.disabled = true;
  elements.cancel.disabled = false;
  elements.cancel.classList.remove("hidden");
  elements["progress-wrap"].classList.remove("hidden");
  elements["review-section"].classList.add("hidden");
  setProgress(0, "Preparando documento");

  try {
    const ranges = collectRanges();
    const pdfMode = isPdf(state.files[0]);
    if (selectedEngine() === "text" && !pdfMode) throw new Error("El motor de texto sólo puede utilizarse con PDF.");
    if (pdfMode) state.pdf = await loadPdf(state.files[0]);
    const tasks = pdfMode ? pdfTasks(state.pdf, ranges) : imageTasks(ranges);

    for (let index = 0; index < tasks.length; index += 1) {
      if (state.cancelRequested) break;
      const task = tasks[index];
      const base = index / tasks.length;
      const span = 1 / tasks.length;
      const pageDescription = task.kind === "pdf" ? `página ${task.printedPage}` : `imagen ${task.printedPage}`;
      setProgress(base, `Analizando ${pageDescription}`);

      let records = [];
      if (task.kind === "pdf" && selectedEngine() !== "ocr") {
        const textPage = await getPdfTextPage(state.pdf, task.physicalPage);
        const useText = selectedEngine() === "text" || textPage.meaningfulTextItems >= 15;
        if (useText) {
          records = detectAssignments(
            textPage.tokens,
            task.services,
            sourceInfo(task, "texto", textPage.viewport.width, textPage.viewport.height)
          );
        } else {
          const canvas = await renderPdfPage(state.pdf, task.physicalPage);
          const ocr = await recognizeCanvas(canvas, message => {
            setProgress(base + span * (message.progress || 0), `${ocrStatus(message)} · ${pageDescription}`);
          });
          records = detectAssignments(ocr.tokens, task.services, sourceInfo(task, "ocr", ocr.width, ocr.height));
        }
      } else {
        const canvas = task.kind === "pdf"
          ? await renderPdfPage(state.pdf, task.physicalPage)
          : await fileToCanvas(state.files[task.fileIndex]);
        const ocr = await recognizeCanvas(canvas, message => {
          setProgress(base + span * (message.progress || 0), `${ocrStatus(message)} · ${pageDescription}`);
        });
        records = detectAssignments(ocr.tokens, task.services, sourceInfo(task, "ocr", ocr.width, ocr.height));
      }
      state.records.push(...records);
      setProgress((index + 1) / tasks.length, `${records.length} circulaciones · ${pageDescription}`);
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    await terminateOcr().catch(() => {});
    if (state.cancelRequested) {
      setNotice(`Proceso detenido. Se conservan ${state.records.length} filas ya extraídas.`);
    } else if (!state.records.length) {
      setNotice("No se han detectado circulaciones válidas. Revisa el motor elegido, los bloques y la calidad del documento.", "error");
    } else {
      setNotice(`Extracción terminada: ${state.records.length} filas preparadas para revisión.`);
    }
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
  const analysis = analyzeRecords(state.records);
  const conflictsByRecord = new Map();
  for (const conflict of analysis.conflicts) {
    for (const id of conflict.records) {
      if (!conflictsByRecord.has(id)) conflictsByRecord.set(id, []);
      conflictsByRecord.get(id).push(`Conflicto ${conflict.service}/${conflict.circulation}: ${conflict.turns.join(" · ")}`);
    }
  }
  const baseConflicts = [];
  if (state.specialBase && elements["special-conflict-policy"].value === "review") {
    for (const item of analysis.expanded) {
      if (!/^[67]\d{2}$/.test(item.service.padStart(3, "0"))) continue;
      const existingTurn = state.specialBase.services[item.service]?.[item.circulation];
      if (existingTurn && existingTurn !== item.turn) {
        baseConflicts.push({ ...item, existingTurn });
        if (!conflictsByRecord.has(item.record.id)) conflictsByRecord.set(item.record.id, []);
        conflictsByRecord.get(item.record.id).push(`El JSON actual contiene ${item.service}/${item.circulation} → ${existingTurn}`);
      }
    }
  }
  return { analysis, conflictsByRecord, baseConflicts };
}

function rowIssues(record, conflictsByRecord) {
  return [
    ...(record.issues || []),
    ...validateRecord(record).issues,
    ...(conflictsByRecord.get(record.id) || [])
  ];
}

function renderReview() {
  elements["review-section"].classList.remove("hidden");
  const { analysis, conflictsByRecord, baseConflicts } = dynamicIssues();
  const issueRows = state.records.filter(record => rowIssues(record, conflictsByRecord).length).length;
  const specialAssignments = analysis.expanded.filter(item => /^[67]\d{2}$/.test(item.service.padStart(3, "0"))).length;
  elements.stats.innerHTML = [
    [state.records.length, "Filas detectadas", ""],
    [analysis.expanded.length, "Asignaciones", ""],
    [specialAssignments, "Especiales", ""],
    [issueRows, "Con incidencias", issueRows ? "alert" : ""]
  ].map(([value, label, style]) => `<div class="stat ${style}"><strong>${value}</strong><span>${label}</span></div>`).join("");

  const query = elements.search.value.trim().toUpperCase();
  const onlyIssues = elements["issues-only"].checked;
  const filtered = state.records.filter(record => {
    const issues = rowIssues(record, conflictsByRecord);
    const haystack = [record.sourceName, record.pageLabel, record.serviceA, record.serviceB, record.turnA, record.turnB, record.circulation, record.rawTurn].join(" ").toUpperCase();
    return (!query || haystack.includes(query)) && (!onlyIssues || issues.length);
  });

  elements["review-body"].innerHTML = filtered.map(record => {
    const issues = rowIssues(record, conflictsByRecord);
    const confidenceClass = record.confidence < 70 ? "bad" : record.confidence < 85 ? "warn" : "";
    const engineLabel = record.engine === "ocr" ? `OCR ${record.confidence}%` : "Texto PDF";
    return `<tr data-id="${record.id}" class="${issues.length ? "has-issue" : ""}">
      <td class="source-cell"><strong>${escapeHtml(record.sourceName)}</strong><br>Pág. ${escapeHtml(record.pageLabel)}
        ${record.sourceKind === "manual" ? "" : `<button type="button" data-action="preview">Ver origen</button>`}</td>
      <td><input data-field="serviceA" maxlength="3" inputmode="numeric" value="${escapeHtml(record.serviceA)}" aria-label="Servicio A"></td>
      <td><input data-field="turnA" maxlength="3" value="${escapeHtml(record.turnA)}" aria-label="Turno A"></td>
      <td><input data-field="serviceB" maxlength="3" inputmode="numeric" value="${escapeHtml(record.serviceB)}" aria-label="Servicio B"></td>
      <td><input data-field="turnB" maxlength="3" value="${escapeHtml(record.turnB)}" aria-label="Turno B"></td>
      <td><input data-field="circulation" maxlength="4" value="${escapeHtml(record.circulation)}" aria-label="Circulación"></td>
      <td class="confidence"><strong class="${confidenceClass}">${engineLabel}</strong><small>${escapeHtml(issues.join(" · ") || record.rawTurn || "Validado")}</small></td>
      <td><div class="row-actions"><button class="icon-button" type="button" data-action="delete" aria-label="Eliminar fila">×</button></div></td>
    </tr>`;
  }).join("");
  elements["empty-review"].classList.toggle("hidden", filtered.length > 0);

  const blocking = analysis.invalid.length + analysis.conflicts.length + baseConflicts.length;
  elements["export-status"].textContent = blocking
    ? `${blocking} incidencia${blocking === 1 ? "" : "s"} bloquean la exportación afectada.`
    : "Datos válidos. Los JSON pueden generarse.";
}

function addManualRecord() {
  let range;
  try { range = collectRanges()[0]; } catch { range = { serviceA: "0", serviceB: "100" }; }
  state.records.unshift({
    id: crypto.randomUUID(),
    sourceId: "manual",
    sourceName: "Entrada manual",
    sourceKind: "manual",
    fileIndex: -1,
    pageLabel: "—",
    physicalPage: null,
    engine: "manual",
    serviceA: range.serviceA,
    serviceB: range.serviceB,
    turnA: "",
    turnB: "",
    circulation: "",
    rawTurn: "",
    confidence: 100,
    issues: [],
    geometry: null
  });
  renderReview();
  elements["review-body"].querySelector("input[data-field='turnA']")?.focus();
}

async function showSource(record) {
  elements["dialog-title"].textContent = `${record.sourceName} · página ${record.pageLabel}`;
  elements["dialog-caption"].textContent = record.rawTurn ? `Lectura TORN: ${record.rawTurn.replace(/\n/g, " · ")}` : "No se obtuvo una lectura TORN.";
  const canvas = elements["source-canvas"];
  const context = canvas.getContext("2d");
  canvas.width = 640; canvas.height = 320;
  context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#666"; context.font = "16px sans-serif"; context.fillText("Preparando vista…", 24, 42);
  elements["source-dialog"].showModal();
  try {
    if (record.sourceKind === "pdf") {
      await renderPdfPreview(state.pdf, record.physicalPage, canvas, record.geometry);
    } else {
      await renderImagePreview(state.files[record.fileIndex], canvas, record.geometry);
    }
  } catch {
    elements["dialog-caption"].textContent = "No se ha podido generar la vista del origen.";
  }
}

async function exportKind(kind) {
  const result = buildJson(state.records, kind);
  if (result.invalid.length || result.conflicts.length) {
    elements["issues-only"].checked = true;
    renderReview();
    setNotice(`Corrige las filas no válidas o los conflictos antes de exportar el JSON ${kind === "special" ? "especial" : "ordinario"}.`, "error");
    elements["review-section"].scrollIntoView({ behavior: "smooth" });
    return;
  }
  const filename = kind === "special" ? "sim_turnos_especiales.json" : "sim_turnos_servicios.json";
  let payload = result.payload;
  if (kind === "special" && state.specialBase) {
    const merged = mergeSpecialJson(
      payload,
      state.specialBase.services,
      elements["special-conflict-policy"].value,
      state.specialBase.template
    );
    if (merged.conflicts.length && elements["special-conflict-policy"].value === "review") {
      elements["issues-only"].checked = true;
      renderReview();
      setNotice(`Hay ${merged.conflicts.length} conflicto${merged.conflicts.length === 1 ? "" : "s"} con el JSON actual. Elige qué versión debe prevalecer.`, "error");
      elements["review-section"].scrollIntoView({ behavior: "smooth" });
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
    state.specialBase = validateSpecialJson(parsed);
    elements["special-base-summary"].textContent = `${file.name} · ${state.specialBase.serviceCount} servicios · ${state.specialBase.assignments} asignaciones conservadas`;
    elements["clear-special-base"].classList.remove("hidden");
    setNotice("JSON de servicios especiales cargado. La exportación incluirá sus datos y los nuevos.");
    if (state.records.length) renderReview();
  } catch (error) {
    state.specialBase = null;
    elements["special-base-input"].value = "";
    elements["special-base-summary"].textContent = "Sin archivo base · se creará uno nuevo";
    elements["clear-special-base"].classList.add("hidden");
    setNotice(error?.message || "No se ha podido leer el JSON actual.", "error");
  }
}

elements["file-input"].addEventListener("change", event => updateFileSelection(event.target.files));
elements.dropzone.addEventListener("dragover", event => { event.preventDefault(); elements.dropzone.classList.add("dragging"); });
elements.dropzone.addEventListener("dragleave", () => elements.dropzone.classList.remove("dragging"));
elements.dropzone.addEventListener("drop", event => {
  event.preventDefault();
  elements.dropzone.classList.remove("dragging");
  updateFileSelection(event.dataTransfer.files);
});
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
  if (button.dataset.action === "delete") {
    state.records = state.records.filter(item => item.id !== record.id);
    renderReview();
  } else if (button.dataset.action === "preview") {
    showSource(record);
  }
});
elements["export-regular"].addEventListener("click", () => exportKind("regular"));
elements["export-special"].addEventListener("click", () => exportKind("special"));
elements["special-base-input"].addEventListener("change", event => {
  const [file] = event.target.files;
  if (file) loadSpecialBase(file);
});
elements["clear-special-base"].addEventListener("click", () => {
  state.specialBase = null;
  elements["special-base-input"].value = "";
  elements["special-base-summary"].textContent = "Sin archivo base · se creará uno nuevo";
  elements["clear-special-base"].classList.add("hidden");
  setNotice("Archivo base retirado. La próxima exportación especial contendrá sólo los datos revisados.");
  if (state.records.length) renderReview();
});
elements["special-conflict-policy"].addEventListener("change", () => { if (state.records.length) renderReview(); });
elements["export-audit"].addEventListener("click", async () => {
  const hash = await downloadJson("sim_turnos_auditoria.json", buildAudit(state.records, state.files));
  setNotice(`sim_turnos_auditoria.json generado. SHA-256: ${hash}`);
});
elements["close-dialog"].addEventListener("click", () => elements["source-dialog"].close());
elements["source-dialog"].addEventListener("click", event => {
  if (event.target === elements["source-dialog"]) elements["source-dialog"].close();
});

setRanges(DEFAULT_RANGES);
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("./service-worker.js").catch(() => {});
}
