function normalizedText(pages) {
  return pages
    .map(page => [...(page.tokens || [])]
      .sort((a, b) => (a.y - b.y) || (a.x - b.x))
      .map(token => token.text)
      .join(" "))
    .join(" \n ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function addEvidence(target, points, label) {
  target.score += points;
  target.evidence.push(label);
}

export function classifyDocument(pages, { fileName = "", pageCount = pages.length } = {}) {
  const text = normalizedText(pages);
  const name = String(fileName).toUpperCase();
  const circular = { score: 0, evidence: [] };
  const book = { score: 0, evidence: [] };

  if (/^OS\d{5,}/.test(name)) addEvidence(circular, 7, "nombre OS");
  if (/ORDRE DE SERVEI/.test(text)) addEvidence(circular, 8, "Ordre de Servei");
  if (/SERVEI ESPECIAL PER (?:A|AL) DIA/.test(text)) addEvidence(circular, 7, "servicio especial fechado");
  if (/REFORC AL SERVEI|TORNS? MODIFICATS?|TORNS? ADDICIONALS?|TORNS? CREATS?/.test(text)) {
    addEvidence(circular, 7, "turnos modificados o adicionales");
  }
  if (/\bDIA\s+\d{1,2}(?:\s+DE\s+[A-Z]+\s+DE\s+20\d{2}|[-/.]\d{1,2}[-/.](?:\d{2}|20\d{2}))/.test(text)) {
    addEvidence(circular, 3, "fecha operativa");
  }
  if (/\bQ\d[A-Z0-9]{3}\b/.test(text)) addEvidence(circular, 3, "cabeceras de turno");

  if (pageCount >= 200) addEvidence(book, 6, "extensión de libro");
  if (/LLIBRE D['’ ]?ITINERARIS|LIBRO DE ITINERARIOS/.test(text)) addEvidence(book, 9, "Llibre d’itineraris");
  if (/ITINERARI\s+BV\d+/.test(text)) addEvidence(book, 7, "itinerari BV");
  if (/PAG\.?\s*TREN SEGUENT|TREN SEGUENT/.test(text)) addEvidence(book, 4, "referencias al tren siguiente");
  if (/SERVEI\s+(?:0\s*\/\s*100|400\s*\/\s*500|200\s*\/\s*300|600\s*\/\s*700|800\s*\/\s*900)/.test(text)) {
    addEvidence(book, 6, "par de servicios ordinarios");
  }
  if (/\bTORN\b/.test(text) && /CODI SIV/.test(text) && circular.score === 0) {
    addEvidence(book, 3, "tabla ordinaria TORN");
  }

  const difference = Math.abs(circular.score - book.score);
  let mode = null;
  if (circular.score >= 5 && circular.score > book.score) mode = "circular";
  if (book.score >= 5 && book.score > circular.score) mode = "book";
  const confidence = mode ? Math.min(100, 55 + difference * 5) : 0;
  return {
    mode,
    confidence,
    scores: { circular: circular.score, book: book.score },
    evidence: mode === "circular" ? circular.evidence : mode === "book" ? book.evidence : []
  };
}

export function documentModeLabel(mode) {
  return mode === "circular" ? "circular o PDF de turnos" : mode === "book" ? "libro de itinerarios" : "documento no identificado";
}

export function inferBookOffset(pageCount) {
  return Number(pageCount) >= 318 ? 24 : 0;
}

// Read the printed service, never round 707 to 700 or 203 to 200.
export function servicesOnPage(tokens) {
  const labels = tokens.filter(token => /^servei:?$/i.test(token.text.trim()));
  for (const label of labels.sort((a, b) => b.y - a.y)) {
    const height = Math.max(1, label.height || 10);
    const nearby = tokens.filter(token => token !== label && token.x >= label.x
      && token.x < label.x + height * 25 && Math.abs(token.y - label.y) < height * 1.5)
      .sort((a, b) => a.x - b.x).map(token => token.text).join(' ');
    const match = nearby.match(/^\s*(\d{1,3})(?:\s*[\/–-]\s*(\d{1,3}))?(?=\s|$)/);
    if (match) return [match[1], match[2]].filter(Boolean).map(value => String(Number(value)));
  }
  return [];
}
