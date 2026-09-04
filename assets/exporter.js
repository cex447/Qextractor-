import { isSpecialService, normalizeCirculation, normalizeService, normalizeTurn, validateRecord } from "./parser.js";

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

export function buildAudit(records, sources) {
  const analysis = analyzeRecords(records);
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
      servicio_a: record.serviceA,
      turno_a: record.turnA,
      servicio_b: record.serviceB,
      turno_b: record.turnB,
      circulacion: record.circulation,
      lectura_original: record.rawTurn,
      confianza: record.confidence,
      incidencias: [...(record.issues || []), ...validateRecord(record).issues]
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
