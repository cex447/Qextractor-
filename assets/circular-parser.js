import { normalizeCirculation, normalizeTurn } from "./parser.js";

const MONTHS = {
  gener: 1, febrer: 2, marc: 3, abril: 4, maig: 5, juny: 6,
  juliol: 7, agost: 8, setembre: 9, octubre: 10, novembre: 11, desembre: 12
};

function cleanText(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function centerX(token) {
  return token.x + token.width / 2;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export function tokensToLines(tokens) {
  const ordered = [...tokens].filter(token => String(token.text ?? "").trim()).sort((a, b) => {
    const tolerance = Math.max(a.height || 1, b.height || 1) * 0.55;
    return Math.abs(a.y - b.y) <= tolerance ? a.x - b.x : a.y - b.y;
  });
  const tolerance = Math.max(3, median(ordered.map(token => token.height || 1)) * 0.65);
  const lines = [];
  for (const token of ordered) {
    let line = lines.find(item => Math.abs(item.y - token.y) <= tolerance);
    if (!line) {
      line = { y: token.y, tokens: [] };
      lines.push(line);
    }
    line.tokens.push(token);
  }
  return lines
    .sort((a, b) => a.y - b.y)
    .map(line => ({
      y: line.y,
      tokens: line.tokens.sort((a, b) => a.x - b.x),
      text: line.tokens.sort((a, b) => a.x - b.x).map(token => token.text).join(" ").replace(/\s+/g, " ").trim()
    }));
}

function validDate(day, month, year) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatDate(day, month, year) {
  if (!validDate(day, month, year)) return null;
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

export function datesFromLine(text) {
  const normalized = cleanText(text).toLowerCase();
  if (!/(?:\bdia\b|\bnit\b|\bservei\b)/.test(normalized)) return [];
  const dates = [];
  const words = new RegExp(`(\\d{1,2})\\s+de\\s+(${Object.keys(MONTHS).join("|")})\\s+de\\s+(20\\d{2})`, "g");
  for (const match of normalized.matchAll(words)) {
    const date = formatDate(Number(match[1]), MONTHS[match[2]], Number(match[3]));
    if (date) dates.push(date);
  }
  for (const match of normalized.matchAll(/\b(?:dia\s*)?(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|20\d{2})\b/g)) {
    const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
    const date = formatDate(Number(match[1]), Number(match[2]), year);
    if (date) dates.push(date);
  }
  return [...new Set(dates)];
}

function serviceFromLine(text) {
  const match = cleanText(text).toUpperCase().match(/\bSERVEI\s+(\d{3})\b/);
  return match ? match[1] : "";
}

function pageMarkers(lines) {
  const markers = [];
  for (const line of lines) {
    for (const date of datesFromLine(line.text)) {
      markers.push({ y: line.y, date, baseService: serviceFromLine(line.text), text: line.text });
    }
  }
  return markers.sort((a, b) => a.y - b.y);
}

function turnFromDutyHeader(value) {
  const raw = cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  let candidate = null;
  if (/^Q\d[A-Z0-9]{3}$/.test(raw)) candidate = raw.slice(2);
  else if (/^Q(?:\d{3}|[A-Z]\d{2}|R[A-Z]\d)$/.test(raw)) candidate = raw.slice(1);
  const turn = normalizeTurn(candidate);
  return turn?.value || null;
}

function dateForY(markers, y, contextDate, defaultDate) {
  return [...markers].reverse().find(marker => marker.y <= y + 2)?.date || contextDate || defaultDate || "";
}

function serviceForY(markers, y, contextService) {
  return [...markers].reverse().find(marker => marker.y <= y + 2 && marker.baseService)?.baseService || contextService || "";
}

function groupDutyHeaders(tokens) {
  const headers = tokens
    .map(token => ({ ...token, dutyTurn: turnFromDutyHeader(token.text) }))
    .filter(token => token.dutyTurn)
    .sort((a, b) => Math.abs(a.y - b.y) < Math.max(a.height, b.height) * 0.55 ? a.x - b.x : a.y - b.y);
  const tolerance = Math.max(4, median(headers.map(header => header.height || 1)) * 0.7);
  const groups = [];
  for (const header of headers) {
    let group = groups.find(item => Math.abs(item.y - header.y) <= tolerance);
    if (!group) {
      group = { y: header.y, headers: [] };
      groups.push(group);
    }
    group.headers.push(header);
  }
  return groups.sort((a, b) => a.y - b.y).map(group => ({ ...group, headers: group.headers.sort((a, b) => centerX(a) - centerX(b)) }));
}

function confidenceFor(header, train) {
  const values = [header.confidence, train.confidence].filter(Number.isFinite);
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 100;
}

function anyTrain(value) {
  const raw = cleanText(value).toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Códigos SIV como L12A/L12B ocupan la línea inmediatamente anterior a TORN.
  // No son circulaciones y la B final no debe corregirse a un 8 de OCR.
  if (/^L\d{2}[AB]$/.test(raw)) return null;
  if (/^[ABLDF]\d{3}$/.test(raw)) return raw;
  if (!/^[ABLDF][0-9OQDILZSGB]{3}$/.test(raw)) return null;
  const digits = { O: "0", Q: "0", D: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
  const candidate = raw[0] + [...raw.slice(1)].map(char => digits[char] ?? char).join("");
  return /^[A-Z]\d{3}$/.test(candidate) ? candidate : null;
}

function detectDirectTornAssignments(page, contextDate, defaultDate) {
  const lines = tokensToLines(page.tokens);
  const markers = pageMarkers(lines);
  const tornTokens = page.tokens.filter(token => cleanText(token.text).toUpperCase().replace(/0/g, "O") === "TORN");
  const results = [];
  const yTolerance = Math.max(4, median(tornTokens.map(token => token.height || 1)) * 0.7);
  const tornRows = [];
  for (const torn of [...tornTokens].sort((a, b) => a.y - b.y || a.x - b.x)) {
    let row = tornRows.find(item => Math.abs(item.y - torn.y) <= yTolerance);
    if (!row) {
      row = { y: torn.y, torns: [] };
      tornRows.push(row);
    }
    row.torns.push(torn);
  }

  for (const tornRow of tornRows) {
    const torns = tornRow.torns.sort((a, b) => a.x - b.x);
    for (let tableIndex = 0; tableIndex < torns.length; tableIndex += 1) {
      const torn = torns[tableIndex];
      const tableLeft = Math.max(0, torn.x - 4);
      const tableRight = tableIndex < torns.length - 1 ? torns[tableIndex + 1].x - 4 : page.sourceWidth;
      const candidates = page.tokens
        .map(token => ({ ...token, anyTrain: anyTrain(token.text) }))
        .filter(token => token.anyTrain && centerX(token) > tableLeft && centerX(token) < tableRight)
        .filter(token => {
          const distance = torn.y - token.y;
          return distance > Math.max(8, token.height * 0.8) && distance < Math.max(100, token.height * 8);
        });
      if (!candidates.length) continue;
      const headerY = Math.max(...candidates.map(token => token.y));
      const headerTolerance = Math.max(4, median(candidates.map(token => token.height || 1)) * 0.7);
      const headers = candidates
        .filter(token => Math.abs(token.y - headerY) <= headerTolerance)
        .sort((a, b) => centerX(a) - centerX(b));
      if (!headers.length) continue;

      const centers = headers.map(centerX);
      const gaps = centers.slice(1).map((center, index) => center - centers[index]).filter(gap => gap > 3);
      const fallback = median(gaps) || Math.max(30, (tableRight - tableLeft) / Math.max(headers.length, 1));
      for (let headerIndex = 0; headerIndex < headers.length; headerIndex += 1) {
        const header = headers[headerIndex];
        const circulation = normalizeCirculation(header.anyTrain);
        if (!circulation) continue;
        const left = headerIndex > 0 ? (centers[headerIndex - 1] + centers[headerIndex]) / 2 : Math.max(tableLeft, centers[headerIndex] - fallback / 2);
        const right = headerIndex < centers.length - 1 ? (centers[headerIndex] + centers[headerIndex + 1]) / 2 : Math.min(tableRight, centers[headerIndex] + fallback / 2);
        const turnTokens = page.tokens
          .filter(token => token.id !== torn.id)
          .filter(token => Math.abs(token.y - torn.y) <= Math.max(yTolerance, torn.height * 0.9))
          .filter(token => centerX(token) >= left && centerX(token) < right)
          .sort((a, b) => a.x - b.x);
        const rawTurn = turnTokens.map(token => token.text).join("").replace(/\s+/g, "");
        const turn = normalizeTurn(rawTurn);
        const date = dateForY(markers, header.y, contextDate, defaultDate);
        const confidence = confidenceFor(header, turnTokens[0] || header);
        const issues = [];
        if (!date) issues.push("No se ha podido determinar la fecha operativa");
        if (!turn) issues.push("No se ha podido leer el turno de la columna");
        if (page.engine === "ocr" && confidence < 80) issues.push("Confianza OCR baja");
        if (circulation.corrected) issues.push("Circulación corregida por OCR");
        if (turn?.corrected) issues.push("Turno corregido por OCR");
        results.push({
          ...page,
          kind: "circular",
          id: crypto.randomUUID(),
          date,
          baseService: serviceForY(markers, header.y, ""),
          circulation: circulation.value,
          turn: turn?.value || "",
          rawTurn,
          extractionFormat: "fila-torn",
          confidence,
          issues,
          geometry: {
            x: left,
            y: Math.max(0, header.y - header.height * 1.5),
            width: Math.max(1, right - left),
            height: Math.max(1, torn.y - header.y + header.height * 2.5),
            sourceWidth: page.sourceWidth,
            sourceHeight: page.sourceHeight
          }
        });
      }
    }
  }
  return { records: results, markers };
}

function detectDutyAssignments(page, contextDate, contextService, defaultDate) {
  const lines = tokensToLines(page.tokens);
  const markers = pageMarkers(lines);
  const groups = groupDutyHeaders(page.tokens);
  const results = [];

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    const nextGroupY = groups[groupIndex + 1]?.y ?? page.sourceHeight;
    const nextDateY = markers.find(marker => marker.y > group.y + 4)?.y ?? page.sourceHeight;
    const bottom = Math.min(nextGroupY - 3, nextDateY - 3, page.sourceHeight - 20);
    if (bottom <= group.y + 10) continue;

    const centers = group.headers.map(centerX);
    const gaps = centers.slice(1).map((center, index) => center - centers[index]).filter(gap => gap > 10);
    const fallback = median(gaps) || Math.max(150, page.sourceWidth / 3.4);

    for (let headerIndex = 0; headerIndex < group.headers.length; headerIndex += 1) {
      const header = group.headers[headerIndex];
      const left = headerIndex > 0 ? (centers[headerIndex - 1] + centers[headerIndex]) / 2 : Math.max(0, centers[headerIndex] - fallback / 2);
      const right = headerIndex < centers.length - 1 ? (centers[headerIndex] + centers[headerIndex + 1]) / 2 : Math.min(page.sourceWidth, centers[headerIndex] + fallback / 2);
      const date = dateForY(markers, group.y, contextDate, defaultDate);
      const baseService = serviceForY(markers, group.y, contextService);
      const trains = page.tokens.filter(token => {
        if (token.y <= group.y + Math.max(10, header.height * 1.15) || token.y >= bottom) return false;
        if (centerX(token) < left || centerX(token) >= right) return false;
        return Boolean(normalizeCirculation(token.text));
      });

      const seen = new Set();
      for (const train of trains) {
        const circulation = normalizeCirculation(train.text);
        if (!circulation || seen.has(circulation.value)) continue;
        seen.add(circulation.value);
        const confidence = confidenceFor(header, train);
        const issues = [];
        if (!date) issues.push("No se ha podido determinar la fecha operativa");
        if (page.engine === "ocr" && confidence < 80) issues.push("Confianza OCR baja");
        if (circulation.corrected) issues.push("Circulación corregida por OCR");
        results.push({
          ...page,
          kind: "circular",
          id: crypto.randomUUID(),
          date,
          baseService,
          circulation: circulation.value,
          turn: header.dutyTurn,
          rawTurn: header.text,
          extractionFormat: "turno-modificado",
          confidence,
          issues,
          geometry: {
            x: left,
            y: Math.max(0, group.y - header.height),
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - group.y + header.height),
            sourceWidth: page.sourceWidth,
            sourceHeight: page.sourceHeight
          }
        });
      }
    }
  }
  return { records: results, markers };
}

function detectTimetableAssignments(page, contextDate, defaultDate) {
  return detectDirectTornAssignments(page, contextDate, defaultDate);
}

export function detectCircularAssignments(documents, fallbackDate = "") {
  const allMarkerDates = [];
  for (const documentPages of documents) {
    for (const page of documentPages) {
      for (const marker of pageMarkers(tokensToLines(page.tokens))) allMarkerDates.push(marker.date);
    }
  }
  const uniqueDates = [...new Set(allMarkerDates)];
  const globalDefault = fallbackDate || (uniqueDates.length === 1 ? uniqueDates[0] : "");
  const records = [];

  for (const documentPages of documents) {
    let contextDate = globalDefault;
    let contextService = "";
    for (const page of documentPages) {
      const duty = detectDutyAssignments(page, contextDate, contextService, globalDefault);
      const timetable = detectTimetableAssignments(page, contextDate, globalDefault);
      records.push(...duty.records, ...timetable.records);
      const markers = duty.markers;
      if (markers.length) {
        contextDate = markers.at(-1).date || contextDate;
        contextService = [...markers].reverse().find(marker => marker.baseService)?.baseService || contextService;
      }
    }
  }

  const byKey = new Map();
  for (const record of records) {
    const key = `${record.date}|${record.circulation}|${record.turn}`;
    const previous = byKey.get(key);
    if (!previous || (previous.extractionFormat === "turno-modificado" && record.extractionFormat === "fila-torn")) {
      byKey.set(key, record);
    }
  }
  const deduplicated = [...byKey.values()];
  const pairsWithTurn = new Set(deduplicated.filter(record => record.turn).map(record => `${record.date}|${record.circulation}`));
  return deduplicated.filter(record => record.turn || !pairsWithTurn.has(`${record.date}|${record.circulation}`)).sort((a, b) => {
    const [ad, am, ay] = (a.date || "99/99/9999").split("/").map(Number);
    const [bd, bm, by] = (b.date || "99/99/9999").split("/").map(Number);
    return (ay - by) || (am - bm) || (ad - bd) || a.circulation.localeCompare(b.circulation);
  });
}

export function validateCircularRecord(record) {
  const dateMatch = String(record.date ?? "").match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
  const date = dateMatch ? formatDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])) : null;
  const circulation = normalizeCirculation(record.circulation);
  const turn = normalizeTurn(record.turn);
  const issues = [];
  if (!date) issues.push("Fecha no válida; utiliza DD/MM/AAAA");
  if (!circulation) issues.push("Circulación no válida");
  if (!turn) issues.push("Turno no válido");
  return {
    valid: issues.length === 0,
    issues,
    normalized: { date: date || "", circulation: circulation?.value || "", turn: turn?.value || "" }
  };
}
