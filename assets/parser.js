const VALID_CIRCULATION = /^[ABLDF][0-79]\d{2}$/;
const ANY_TRAIN = /^[A-Z]\d{3}$/;
const VALID_TURN = /^(?:\d{3}|[A-Z]\d{2}|R[A-Z]\d)$/;
const LINE_LABELS = new Set(["S1", "S2", "L6", "L7", "L12"]);

const DIGIT_SUBSTITUTIONS = {
  O: "0", Q: "0", D: "0",
  I: "1", L: "1", "|": "1",
  Z: "2", S: "5", G: "6", B: "8"
};

function clean(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[^A-Z0-9|\-]/g, "");
}

function toDigit(char) {
  if (/\d/.test(char)) return char;
  return DIGIT_SUBSTITUTIONS[char] ?? char;
}

export function normalizeService(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  if (!Number.isInteger(number) || number < 0 || number > 999) return null;
  return String(number);
}

export function serviceSuffix(service) {
  const normalized = normalizeService(service);
  if (normalized === null) return null;
  return String(Math.floor(Number(normalized) / 100));
}

export function isSpecialService(service) {
  const normalized = normalizeService(service);
  return normalized !== null && /^[67]\d{2}$/.test(normalized.padStart(3, "0"));
}

export function normalizeCirculation(value) {
  const raw = clean(value);
  if (VALID_CIRCULATION.test(raw)) return { value: raw, corrected: false };
  if (!/^[ABLDF][A-Z0-9|]{3}$/.test(raw)) return null;
  const candidate = raw[0] + [...raw.slice(1)].map(toDigit).join("");
  if (!VALID_CIRCULATION.test(candidate)) return null;
  return { value: candidate, corrected: candidate !== raw };
}

export function normalizeTurn(value) {
  const raw = clean(value).replace(/-/g, "");
  if (VALID_TURN.test(raw)) return { value: raw, corrected: false };
  if (raw.length !== 3) return null;

  const numeric = [...raw].map(toDigit).join("");
  if (/^\d{3}$/.test(numeric)) return { value: numeric, corrected: numeric !== raw };

  const prefixed = raw[0] + toDigit(raw[1]) + toDigit(raw[2]);
  if (/^[A-Z]\d{2}$/.test(prefixed)) return { value: prefixed, corrected: prefixed !== raw };

  const doublePrefixed = raw.slice(0, 2) + toDigit(raw[2]);
  if (/^R[A-Z]\d$/.test(doublePrefixed)) return { value: doublePrefixed, corrected: doublePrefixed !== raw };
  return null;
}

function normalizeLineLabel(value) {
  const raw = clean(value);
  if (LINE_LABELS.has(raw)) return raw;
  const fixed = raw.replace(/I/g, "1").replace(/O/g, "0");
  return LINE_LABELS.has(fixed) ? fixed : null;
}

function explodeToken(token) {
  const text = String(token.text ?? "");
  const parts = [...text.matchAll(/\S+/g)];
  const charWidth = token.width / Math.max(text.length, 1);
  let matches = parts;
  if (parts.length <= 1) {
    const embeddedTrains = [...text.toUpperCase().matchAll(/[ABLDF][0-9OQDIL|ZSBG]{3}/g)];
    if (embeddedTrains.length > 1) matches = embeddedTrains;
  }
  return matches.map(match => ({
    ...token,
    text: match[0],
    x: token.x + match.index * charWidth,
    width: match[0].length * charWidth
  })).filter(item => item.text.trim());
}

export function tokensFromPdfText(items, viewport) {
  return items
    .filter(item => typeof item.str === "string" && item.str.trim())
    .flatMap((item, index) => {
      const height = Math.max(Math.abs(item.transform?.[3] || 0), item.height || 1);
      return explodeToken({
        id: `pdf-${index}`,
        text: item.str,
        x: item.transform?.[4] || 0,
        y: viewport.height - (item.transform?.[5] || 0) - height,
        width: Math.max(item.width || 1, 1),
        height,
        confidence: 100
      });
    });
}

export function tokensFromTsv(tsv) {
  if (!tsv) return [];
  const rows = String(tsv).split(/\r?\n/);
  const result = [];
  for (let index = 1; index < rows.length; index += 1) {
    const columns = rows[index].split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const text = columns.slice(11).join("\t").trim();
    if (!text) continue;
    result.push({
      id: `ocr-${index}`,
      text,
      x: Number(columns[6]) || 0,
      y: Number(columns[7]) || 0,
      width: Number(columns[8]) || 1,
      height: Number(columns[9]) || 1,
      confidence: Math.max(0, Number(columns[10]) || 0)
    });
  }
  return result.flatMap(explodeToken);
}

function centerX(token) {
  return token.x + token.width / 2;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function hasLineLabelAbove(header, tokens) {
  const maxDistance = Math.max(16, header.height * 3.2);
  return tokens.some(token => {
    if (!normalizeLineLabel(token.text)) return false;
    const distance = header.y - token.y;
    return distance >= 2 && distance <= maxDistance
      && Math.abs(centerX(header) - centerX(token)) <= Math.max(8, header.width * 0.65);
  });
}

function isTrainLike(token) {
  const raw = clean(token.text);
  if (ANY_TRAIN.test(raw)) return true;
  return /^[A-Z][A-Z0-9|]{3}$/.test(raw)
    && [...raw.slice(1)].every(char => /\d/.test(toDigit(char)));
}

function isTornLabel(token) {
  const text = clean(token.text).replace(/0/g, "O");
  return text === "TORN";
}

function isTrainLabel(token) {
  return clean(token.text).replace(/0/g, "O").startsWith("TREN");
}

function clippedText(token, left, right) {
  const tokenLeft = token.x;
  const tokenRight = token.x + token.width;
  if (tokenRight <= left || tokenLeft >= right) return "";
  if (tokenLeft >= left && tokenRight <= right) return token.text;

  const chars = [...token.text];
  const charWidth = token.width / Math.max(chars.length, 1);
  return chars.filter((_, index) => {
    const charCenter = token.x + (index + 0.5) * charWidth;
    return charCenter >= left && charCenter <= right;
  }).join("");
}

function extractTurnBand(tokens, left, right, top, bottom) {
  const selected = tokens
    .filter(token => token.y + token.height >= top && token.y <= bottom)
    .map(token => ({ ...token, clipped: clippedText(token, left, right) }))
    .filter(token => token.clipped.trim())
    .sort((a, b) => Math.abs(a.y - b.y) < Math.max(a.height, b.height) * 0.45 ? a.x - b.x : a.y - b.y);

  const lineTolerance = Math.max(3, median(selected.map(token => token.height)) * 0.55);
  const lines = [];
  for (const token of selected) {
    let line = lines.find(candidate => Math.abs(candidate.y - token.y) <= lineTolerance);
    if (!line) {
      line = { y: token.y, tokens: [] };
      lines.push(line);
    }
    line.tokens.push(token);
  }
  lines.sort((a, b) => a.y - b.y);
  const text = lines.map(line => line.tokens.sort((a, b) => a.x - b.x).map(token => token.clipped).join(" ")).join("\n");
  return { text, tokens: selected };
}

export function parseTurnExpression(rawText, services) {
  const validServices = services.map(normalizeService).filter(service => service !== null);
  const normalized = String(rawText ?? "")
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/([A-Z0-9|]{3})[.:]([0-9OIS])/g, "$1-$2")
    .replace(/([A-Z0-9|]{3})\s*-\s*([0-9OIS])/g, "$1-$2")
    .replace(/\s+/g, " ")
    .trim();

  const splitMatches = [...normalized.matchAll(/([A-Z0-9|]{3})-([0-9OIS])/g)];
  if (splitMatches.length) {
    const bySuffix = new Map();
    let corrected = false;
    for (const match of splitMatches) {
      const turn = normalizeTurn(match[1]);
      const suffix = toDigit(match[2]);
      if (!turn || !/^\d$/.test(suffix)) continue;
      corrected ||= turn.corrected || suffix !== match[2];
      bySuffix.set(suffix, turn.value);
    }
    const assignments = {};
    for (const service of validServices) {
      const suffix = serviceSuffix(service);
      if (bySuffix.has(suffix)) assignments[service] = bySuffix.get(suffix);
    }
    return {
      assignments,
      corrected,
      split: true,
      complete: Object.keys(assignments).length === validServices.length,
      normalized
    };
  }

  const candidates = normalized.match(/[A-Z0-9|]{3}/g) || [];
  for (const candidate of candidates) {
    const turn = normalizeTurn(candidate);
    if (!turn) continue;
    return {
      assignments: Object.fromEntries(validServices.map(service => [service, turn.value])),
      corrected: turn.corrected,
      split: false,
      complete: validServices.length > 0,
      normalized: turn.value
    };
  }
  return { assignments: {}, corrected: false, split: false, complete: false, normalized };
}

function findTurnArea(header, tokens, rowPeers) {
  const peers = rowPeers.sort((a, b) => centerX(a) - centerX(b));
  const position = peers.findIndex(peer => peer.id === header.id);
  const gaps = peers.slice(1).map((peer, index) => centerX(peer) - centerX(peers[index])).filter(gap => gap > 3);
  const fallbackGap = median(gaps) || Math.max(header.width * 1.35, 22);
  const left = position > 0 ? (centerX(peers[position - 1]) + centerX(header)) / 2 : centerX(header) - fallbackGap / 2;
  const right = position >= 0 && position < peers.length - 1 ? (centerX(header) + centerX(peers[position + 1])) / 2 : centerX(header) + fallbackGap / 2;

  const torn = tokens
    .filter(token => isTornLabel(token))
    .filter(token => {
      const distance = token.y - header.y;
      return distance > header.height * 1.25 && distance < Math.max(220, header.height * 10);
    })
    .sort((a, b) => a.y - b.y)[0];
  if (!torn) return null;

  const trainLabel = tokens
    .filter(token => isTrainLabel(token))
    .filter(token => token.y > torn.y && token.y - torn.y < Math.max(90, header.height * 5))
    .sort((a, b) => a.y - b.y)[0];

  const top = torn.y - Math.max(4, header.height * 0.55);
  const bottom = trainLabel ? trainLabel.y - 1 : torn.y + Math.max(28, header.height * 2.2);
  return { left, right, top, bottom, torn, trainLabel };
}

export function detectAssignments(tokens, services, source) {
  const validServices = services.map(normalizeService).filter(service => service !== null);
  const headers = [];
  for (const token of tokens) {
    const circulation = normalizeCirculation(token.text);
    if (!circulation || !hasLineLabelAbove(token, tokens)) continue;
    headers.push({ ...token, circulation });
  }

  const results = [];
  for (const header of headers) {
    const rowTolerance = Math.max(4, header.height * 0.65);
    const rowPeers = tokens.filter(token => isTrainLike(token) && Math.abs(token.y - header.y) <= rowTolerance);
    const area = findTurnArea(header, tokens, rowPeers);
    const issues = [];
    if (header.circulation.corrected) issues.push("Circulación corregida por OCR");
    if (!area) {
      results.push({
        ...source,
        id: crypto.randomUUID(),
        circulation: header.circulation.value,
        serviceA: validServices[0] || "",
        serviceB: validServices[1] || "",
        turnA: "",
        turnB: "",
        rawTurn: "",
        confidence: Math.round(header.confidence),
        issues: [...issues, "No se ha localizado la fila TORN"],
        geometry: null
      });
      continue;
    }

    const band = extractTurnBand(tokens, area.left, area.right, area.top, area.bottom);
    const parsed = parseTurnExpression(band.text, validServices);
    if (!parsed.complete) issues.push("Asignación de servicio incompleta");
    if (parsed.corrected) issues.push("Turno corregido por OCR");
    const confidences = [header.confidence, ...band.tokens.map(token => token.confidence)].filter(Number.isFinite);
    const confidence = Math.round(average(confidences));
    if (source.engine === "ocr" && confidence < 80) issues.push("Confianza OCR baja");

    results.push({
      ...source,
      id: crypto.randomUUID(),
      circulation: header.circulation.value,
      serviceA: validServices[0] || "",
      serviceB: validServices[1] || "",
      turnA: validServices[0] ? parsed.assignments[validServices[0]] || "" : "",
      turnB: validServices[1] ? parsed.assignments[validServices[1]] || "" : "",
      rawTurn: band.text.trim(),
      confidence,
      issues,
      geometry: {
        x: Math.max(0, area.left),
        y: Math.max(0, header.y - header.height * 1.4),
        width: Math.max(1, area.right - area.left),
        height: Math.max(1, area.bottom - header.y + header.height * 1.4),
        sourceWidth: source.sourceWidth,
        sourceHeight: source.sourceHeight
      }
    });
  }

  const seen = new Set();
  return results.filter(result => {
    const key = `${result.sourceId}|${result.physicalPage}|${result.circulation}|${Math.round(result.geometry?.y || 0)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateRecord(record) {
  const issues = [];
  const circulation = normalizeCirculation(record.circulation);
  const serviceA = normalizeService(record.serviceA);
  const serviceB = String(record.serviceB ?? "").trim() ? normalizeService(record.serviceB) : null;
  const turnA = normalizeTurn(record.turnA);
  const turnB = serviceB !== null ? normalizeTurn(record.turnB) : null;

  if (!circulation) issues.push("Circulación no válida");
  if (serviceA === null) issues.push("Servicio A no válido");
  if (!turnA) issues.push("Turno A no válido");
  if (String(record.serviceB ?? "").trim() && serviceB === null) issues.push("Servicio B no válido");
  if (serviceB !== null && !turnB) issues.push("Turno B no válido");
  if (serviceA !== null && serviceB !== null && serviceA === serviceB) issues.push("Servicios duplicados en la misma fila");

  return {
    valid: issues.length === 0,
    issues,
    normalized: {
      circulation: circulation?.value || "",
      serviceA: serviceA ?? "",
      serviceB: serviceB ?? "",
      turnA: turnA?.value || "",
      turnB: turnB?.value || ""
    }
  };
}

export const rules = {
  VALID_CIRCULATION,
  VALID_TURN
};
