import { isSpecialService, normalizeCirculation, normalizeService, normalizeTurn, validateRecord } from "./parser.js";
import { validateCircularRecord } from "./circular-parser.js";

function isoNow() {
  return new Date().toISOString();
}

export function analyzeRecords(records) {
  const expanded = [];
  const invalid = [];
  for (const record of records) {
    const validation = validateRecord(record);
    if (!validation.valid) {
      invalid.push({ record, issues: validation.issues });
      continue;
    }
    const item = validation.normalized;
    expanded.push({ service: item.serviceA, circulation: item.circulation, turn: item.turnA, record });
    if (item.serviceB) expanded.push({ service: item.serviceB, circulation: item.circulation, turn: item.turnB, record });
  }

  const grouped = new Map();
  for (const item of expanded) {
    const key = `${item.service}|${item.circulation}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const conflicts = [];
  for (const [key, items] of grouped) {
    const turns = [...new Set(items.map(item => item.turn))];
    if (turns.length > 1) {
      const [service, circulation] = key.split("|");
      conflicts.push({ service, circulation, turns, records: items.map(item => item.record.id) });
    }
  }
  return { expanded, invalid, conflicts };
}

export function analyzeCircularRecords(records) {
  const expanded = [];
  const invalid = [];
  for (const record of records) {
    const validation = validateCircularRecord(record);
    if (!validation.valid) {
      invalid.push({ record, issues: validation.issues });
      continue;
    }
    expanded.push({ ...validation.normalized, record });
  }
  const grouped = new Map();
  for (const item of expanded) {
    const key = `${item.date}|${item.circulation}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const conflicts = [];
  for (const [key, items] of grouped) {
    const turns = [...new Set(items.map(item => item.turn))];
    if (turns.length > 1) {
      const [date, circulation] = key.split("|");
      conflicts.push({ date, circulation, turns, records: items.map(item => item.record.id) });
    }
  }
  return { expanded, invalid, conflicts };
}

export function buildJson(records, kind) {
  const analysis = analyzeRecords(records);
  const selected = analysis.expanded.filter(item => kind === "special" ? isSpecialService(item.service) : !isSpecialService(item.service));
  const selectedIds = new Set(selected.map(item => item.record.id));
  const invalid = analysis.invalid.filter(item => {
    const a = normalizeService(item.record.serviceA);
    const b = normalizeService(item.record.serviceB);
    return [a, b].filter(Boolean).some(service => kind === "special" ? isSpecialService(service) : !isSpecialService(service));
  });
  const conflicts = analysis.conflicts.filter(conflict => kind === "special" ? isSpecialService(conflict.service) : !isSpecialService(conflict.service));

  const services = {};
  for (const item of selected) {
    services[item.service] ||= {};
    services[item.service][item.circulation] = item.turn;
  }
  const orderedServices = Object.fromEntries(
    Object.entries(services)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([service, assignments]) => [service, Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b)))])
  );

  const payload = {
    schema_version: 1,
    tipo: kind === "special" ? "servicios_especiales" : "servicios_ordinarios",
    descripcion: kind === "special"
      ? "Asignación de número de circulación a turno para servicios especiales de SIM+"
      : "Asignación de número de circulación a turno por tipo de servicio para SIM+",
    generado: isoNow(),
    resumen: {
      servicios: Object.keys(orderedServices).length,
      asignaciones: Object.values(orderedServices).reduce((sum, assignments) => sum + Object.keys(assignments).length, 0),
      circulaciones_por_servicio: Object.fromEntries(
        Object.entries(orderedServices).map(([service, assignments]) => [service, Object.keys(assignments).length])
      )
    },
    servicios: orderedServices
  };
  return { payload, invalid, conflicts, selectedIds };
}

export function validateSpecialJson(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("El JSON de servicios especiales no contiene un objeto válido.");
  }
  if (!payload.servicios || typeof payload.servicios !== "object" || Array.isArray(payload.servicios)) {
    throw new Error("El JSON existente debe contener el objeto \"servicios\".");
  }

  const services = {};
  let assignments = 0;
  for (const [rawService, rawAssignments] of Object.entries(payload.servicios)) {
    const service = normalizeService(rawService);
    if (!isSpecialService(service)) {
      throw new Error(`El servicio ${rawService} no es especial: debe tener tres cifras y comenzar por 6 o 7.`);
    }
    if (!rawAssignments || typeof rawAssignments !== "object" || Array.isArray(rawAssignments)) {
      throw new Error(`El servicio ${service} no contiene un objeto de circulaciones válido.`);
    }
    services[service] = {};
    for (const [rawCirculation, rawTurn] of Object.entries(rawAssignments)) {
      const circulation = normalizeCirculation(rawCirculation);
      const turn = normalizeTurn(rawTurn);
      if (!circulation || !turn) {
        throw new Error(`Asignación no válida en ${service}: ${rawCirculation} → ${rawTurn}.`);
      }
      services[service][circulation.value] = turn.value;
      assignments += 1;
    }
  }
  return { services, serviceCount: Object.keys(services).length, assignments, template: structuredClone(payload) };
}

export function mergeSpecialJson(generatedPayload, existingServices = {}, policy = "review", existingPayload = {}) {
  const services = Object.fromEntries(
    Object.entries(existingServices).map(([service, assignments]) => [service, { ...assignments }])
  );
  const conflicts = [];

  for (const [service, assignments] of Object.entries(generatedPayload.servicios)) {
    services[service] ||= {};
    for (const [circulation, turn] of Object.entries(assignments)) {
      const previous = services[service][circulation];
      if (previous && previous !== turn) {
        conflicts.push({ service, circulation, existingTurn: previous, newTurn: turn });
        if (policy === "existing" || policy === "review") continue;
      }
      services[service][circulation] = turn;
    }
  }

  const orderedServices = Object.fromEntries(
    Object.entries(services)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([service, assignments]) => [service, Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b)))])
  );
  return {
    payload: {
      ...existingPayload,
      ...generatedPayload,
      resumen: {
        servicios: Object.keys(orderedServices).length,
        asignaciones: Object.values(orderedServices).reduce((sum, assignments) => sum + Object.keys(assignments).length, 0),
        circulaciones_por_servicio: Object.fromEntries(
          Object.entries(orderedServices).map(([service, assignments]) => [service, Object.keys(assignments).length])
        )
      },
      servicios: orderedServices
    },
    conflicts
  };
}

function mappingFromDateEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  for (const key of ["circulations", "circulaciones", "trains", "turns", "assignments"]) {
    if (entry[key] && typeof entry[key] === "object" && !Array.isArray(entry[key])) {
      return { key, direct: false, assignments: entry[key] };
    }
  }
  const pairs = Object.entries(entry);
  if (!pairs.length || pairs.every(([circulation, turn]) => normalizeCirculation(circulation) && normalizeTurn(turn))) {
    return { key: null, direct: true, assignments: entry };
  }
  return null;
}

function yearFromOperationalDate(value) {
  const match = String(value).match(/^(\d{2})\/(\d{2})\/(20\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? year : null;
}

export function validateDatedSpecialJson(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("El JSON de servicios especiales no contiene un objeto válido.");
  }
  if (!payload.dates || typeof payload.dates !== "object" || Array.isArray(payload.dates)) {
    throw new Error("El JSON especial debe contener el objeto \"dates\" indexado por fecha.");
  }
  const entries = {};
  let assignments = 0;
  let defaultMappingKey = null;
  const dateYears = new Set();
  for (const [date, entry] of Object.entries(payload.dates)) {
    const dateYear = yearFromOperationalDate(date);
    if (!dateYear) throw new Error(`La fecha ${date} no es válida o no utiliza DD/MM/AAAA.`);
    dateYears.add(dateYear);
    const mapping = mappingFromDateEntry(entry);
    if (!mapping) throw new Error(`No se reconoce el listado de circulaciones de ${date}.`);
    const normalized = {};
    for (const [rawCirculation, rawTurn] of Object.entries(mapping.assignments)) {
      const circulation = normalizeCirculation(rawCirculation);
      const turn = normalizeTurn(rawTurn);
      if (!circulation || !turn) throw new Error(`Asignación no válida en ${date}: ${rawCirculation} → ${rawTurn}.`);
      normalized[circulation.value] = turn.value;
      assignments += 1;
    }
    if (!mapping.direct && !defaultMappingKey) defaultMappingKey = mapping.key;
    entries[date] = { ...mapping, assignments: normalized, template: structuredClone(entry) };
  }
  if (dateYears.size > 1) throw new Error("El JSON anual contiene fechas de años distintos.");
  const declaredYear = Number(payload.year) || null;
  const inferredYear = dateYears.size === 1 ? [...dateYears][0] : null;
  if (declaredYear && inferredYear && declaredYear !== inferredYear) {
    throw new Error(`El JSON declara el año ${declaredYear}, pero contiene fechas de ${inferredYear}.`);
  }
  return {
    year: declaredYear || inferredYear,
    entries,
    dateCount: Object.keys(entries).length,
    assignments,
    defaultMappingKey,
    template: structuredClone(payload)
  };
}

export function datedBaseTurn(base, date, circulation) {
  return base?.entries?.[date]?.assignments?.[circulation] || "";
}

function sortedDates(dates) {
  return Object.fromEntries(Object.entries(dates).sort(([a], [b]) => {
    const [ad, am, ay] = a.split("/").map(Number);
    const [bd, bm, by] = b.split("/").map(Number);
    return (ay - by) || (am - bm) || (ad - bd);
  }));
}

export function buildDatedSpecialJson(records, base = null, policy = "review") {
  const analysis = analyzeCircularRecords(records);
  const years = [...new Set(analysis.expanded.map(item => Number(item.date.slice(-4))))];
  const errors = [];
  if (years.length > 1) errors.push("Un JSON anual no puede mezclar fechas de años distintos.");
  if (base?.year && years.length && base.year !== years[0]) {
    errors.push(`El JSON cargado corresponde a ${base.year}, pero las circulares contienen fechas de ${years[0]}.`);
  }

  const payload = base ? structuredClone(base.template) : {
    year: years[0] || new Date().getFullYear(),
    date_format: "DD/MM/YYYY",
    dates: {}
  };
  payload.year = base?.year || years[0] || payload.year;
  payload.date_format ||= "DD/MM/YYYY";
  payload.dates ||= {};

  const conflicts = [];
  const sourceDocuments = new Map();
  const generated = new Map();
  for (const item of analysis.expanded) {
    if (!generated.has(item.date)) generated.set(item.date, new Map());
    generated.get(item.date).set(item.circulation, item);
    if (!sourceDocuments.has(item.date)) sourceDocuments.set(item.date, new Set());
    if (item.record.sourceName) sourceDocuments.get(item.date).add(item.record.sourceName);
  }

  for (const [date, assignments] of generated) {
    const baseEntry = base?.entries?.[date] || null;
    const existing = { ...(baseEntry?.assignments || {}) };
    for (const [circulation, item] of assignments) {
      const previous = existing[circulation];
      if (previous && previous !== item.turn) {
        conflicts.push({ date, circulation, existingTurn: previous, newTurn: item.turn, record: item.record.id });
        if (policy === "review" || policy === "existing") continue;
      }
      existing[circulation] = item.turn;
    }
    const ordered = Object.fromEntries(Object.entries(existing).sort(([a], [b]) => a.localeCompare(b)));
    if (baseEntry?.direct || (!baseEntry && !base?.defaultMappingKey)) {
      payload.dates[date] = ordered;
    } else {
      const key = baseEntry?.key || base?.defaultMappingKey || "circulations";
      const template = baseEntry ? structuredClone(baseEntry.template) : {};
      template[key] = ordered;
      if (!baseEntry && sourceDocuments.get(date)?.size) template.source_documents = [...sourceDocuments.get(date)].sort();
      payload.dates[date] = template;
    }
  }
  payload.dates = sortedDates(payload.dates);
  return { payload, invalid: analysis.invalid, internalConflicts: analysis.conflicts, conflicts, errors, analysis };
}

export function buildAudit(records, sources) {
  const circular = records.some(record => record.kind === "circular");
  const analysis = circular ? analyzeCircularRecords(records) : analyzeRecords(records);
  return {
    schema_version: 1,
    tipo: "auditoria_extraccion_turnos",
    generado: isoNow(),
    fuentes: sources.map(source => ({ name: source.name, size: source.size, type: source.type })),
    resumen: {
      filas: records.length,
      asignaciones: analysis.expanded.length,
      invalidas: analysis.invalid.length,
      conflictos: analysis.conflicts.length
    },
    conflictos: analysis.conflicts,
    filas: records.map(record => ({
      origen: record.sourceName,
      pagina_impresa: record.pageLabel,
      pagina_pdf: record.physicalPage,
      motor: record.engine,
      fecha: record.date || undefined,
      servicio_base: record.baseService || undefined,
      servicio_a: record.serviceA,
      turno_a: record.turnA || record.turn,
      servicio_b: record.serviceB,
      turno_b: record.turnB,
      circulacion: record.circulation,
      lectura_original: record.rawTurn,
      confianza: record.confidence,
      formato_extraccion: record.extractionFormat || undefined,
      incidencias: [...(record.issues || []), ...(circular ? validateCircularRecord(record).issues : validateRecord(record).issues)]
    }))
  };
}

export async function downloadJson(filename, payload) {
  const text = JSON.stringify(payload, null, 2) + "\n";
  const bytes = new TextEncoder().encode(text);
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
  const blob = new Blob([bytes], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return hash;
}
