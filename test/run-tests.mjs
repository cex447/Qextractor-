import assert from "node:assert/strict";
import {
  detectAssignments,
  isSpecialService,
  normalizeCirculation,
  normalizeTurn,
  parseTurnExpression
} from "../assets/parser.js";
import { datesFromLine, detectCircularAssignments, validateCircularRecord } from "../assets/circular-parser.js";
import { classifyDocument, documentModeLabel, inferBookOffset } from "../assets/document-detector.js";
import {
  buildDatedSpecialJson, buildJson, mergeSpecialJson, validateDatedSpecialJson, validateSpecialJson
} from "../assets/exporter.js";

assert.equal(normalizeCirculation("F012").value, "F012");
assert.equal(normalizeCirculation("H801"), null);
assert.equal(normalizeCirculation("F808"), null);
assert.equal(normalizeTurn("S02").value, "S02");
assert.equal(normalizeTurn("RR8").value, "RR8");
assert.equal(isSpecialService("601"), true);
assert.equal(isSpecialService("500"), false);

const textPage = text => ({ tokens: [{ text, x: 0, y: 0 }] });
assert.equal(classifyDocument([
  textPage("Ordre de Servei Os2026066BV Reforç al servei Torns modificats dia 4 de setembre de 2026")
], { fileName: "os2026066BV.pdf", pageCount: 14 }).mode, "circular");
assert.equal(classifyDocument([
  textPage("Ordre de Servei Os2026074BV Reforç al servei per la Festa Major de Vallvidrera")
], { fileName: "os2026074BV.pdf", pageCount: 4 }).mode, "circular");
assert.equal(classifyDocument([
  textPage("Llibre d'itineraris itinerari BV07 Servei 0/100 Pàg. Tren següent")
], { fileName: "Lit202403.pdf", pageCount: 294 }).mode, "book");
assert.equal(classifyDocument([textPage("document sense marques")], { pageCount: 2 }).mode, null);
assert.equal(documentModeLabel("book"), "libro de itinerarios");
assert.equal(inferBookOffset(294), 0);
assert.equal(inferBookOffset(318), 24);

assert.deepEqual(
  parseTurnExpression("001", ["0", "100"]).assignments,
  { "0": "001", "100": "001" }
);

const syntheticTokens = [
  { id: "l1", text: "L7", x: 90, y: 10, width: 20, height: 10, confidence: 99 },
  { id: "l2", text: "L7", x: 190, y: 10, width: 20, height: 10, confidence: 99 },
  { id: "h1", text: "D090", x: 88, y: 30, width: 24, height: 10, confidence: 99 },
  { id: "h2", text: "F086", x: 188, y: 30, width: 24, height: 10, confidence: 99 },
  { id: "torn", text: "TORN", x: 5, y: 70, width: 35, height: 10, confidence: 99 },
  { id: "a1", text: "312-4", x: 88, y: 72, width: 28, height: 10, confidence: 99 },
  { id: "a2", text: "018-5", x: 88, y: 84, width: 28, height: 10, confidence: 99 },
  { id: "b1", text: "416-4", x: 188, y: 72, width: 28, height: 10, confidence: 99 },
  { id: "b2", text: "F02-5", x: 188, y: 84, width: 28, height: 10, confidence: 99 },
  { id: "train", text: "Tren", x: 5, y: 110, width: 30, height: 10, confidence: 99 }
];
const detected = detectAssignments(syntheticTokens, ["400", "500"], {
  sourceId: "synthetic", sourceName: "test", sourceKind: "image", fileIndex: 0,
  pageLabel: 1, physicalPage: 1, engine: "ocr", sourceWidth: 300, sourceHeight: 180
});
assert.deepEqual(detected.map(row => [row.circulation, row.turnA, row.turnB]), [
  ["D090", "312", "018"],
  ["F086", "416", "F02"]
]);
assert.deepEqual(
  parseTurnExpression("001-4 323-5", ["400", "500"]).assignments,
  { "400": "001", "500": "323" }
);

const records = [
  {
    id: "one", serviceA: "601", turnA: "001", serviceB: "701", turnB: "S02",
    circulation: "D001", issues: []
  },
  {
    id: "two", serviceA: "601", turnA: "R30", serviceB: "", turnB: "",
    circulation: "A002", issues: []
  }
];
const generated = buildJson(records, "special");
assert.equal(generated.invalid.length, 0);
assert.equal(generated.payload.servicios["601"].D001, "001");

const base = validateSpecialJson({
  schema_version: 1,
  tipo: "servicios_especiales",
  servicios: { "601": { "D001": "323", "B003": "004" }, "700": { "F010": "S01" } }
});
assert.equal(base.assignments, 3);

const blocked = mergeSpecialJson(generated.payload, base.services, "review", base.template);
assert.equal(blocked.conflicts.length, 1);
assert.equal(blocked.payload.servicios["601"].D001, "323");
assert.equal(blocked.payload.servicios["601"].A002, "R30");
assert.equal(blocked.payload.servicios["601"].B003, "004");

const replaced = mergeSpecialJson(generated.payload, base.services, "new");
assert.equal(replaced.payload.servicios["601"].D001, "001");
assert.equal(replaced.payload.servicios["700"].F010, "S01");

assert.throws(
  () => validateSpecialJson({ servicios: { "500": { "D001": "001" } } }),
  /no es especial/
);

assert.deepEqual(datesFromLine("Torns modificats SERVEI 400 (dia 12 de setembre de 2026)"), ["12/09/2026"]);
assert.deepEqual(datesFromLine("Servei 100 dia 04-09-26"), ["04/09/2026"]);
assert.equal(validateCircularRecord({ date: "11/09/2026", circulation: "D001", turn: "N13" }).valid, true);

const circularSynthetic = detectCircularAssignments([[
  {
    sourceId: "circular", sourceName: "circular.pdf", sourceKind: "pdf", fileIndex: 0,
    pageLabel: 1, physicalPage: 1, engine: "texto", sourceWidth: 300, sourceHeight: 180,
    tokens: [
      { id: "date", text: "Servei especial dia 11 de setembre de 2026", x: 10, y: 5, width: 190, height: 10, confidence: 100 },
      { id: "d", text: "D001", x: 88, y: 30, width: 24, height: 10, confidence: 100 },
      { id: "f", text: "F001", x: 188, y: 30, width: 24, height: 10, confidence: 100 },
      { id: "siv1", text: "L12B", x: 88, y: 48, width: 24, height: 10, confidence: 100 },
      { id: "siv2", text: "L12B", x: 188, y: 48, width: 24, height: 10, confidence: 100 },
      { id: "torn", text: "TORN", x: 5, y: 70, width: 35, height: 10, confidence: 100 },
      { id: "t1", text: "015", x: 88, y: 70, width: 24, height: 10, confidence: 100 },
      { id: "t2", text: "019", x: 188, y: 70, width: 24, height: 10, confidence: 100 }
    ]
  }
]]);
assert.deepEqual(circularSynthetic.map(row => [row.date, row.circulation, row.turn]), [
  ["11/09/2026", "D001", "015"],
  ["11/09/2026", "F001", "019"]
]);

const datedBase = validateDatedSpecialJson({
  year: 2026,
  date_format: "DD/MM/YYYY",
  dates: {
    "01/01/2026": { "A001": "001" },
    "11/09/2026": { "D001": "313", "F001": "019" }
  }
});
assert.throws(
  () => validateDatedSpecialJson({ year: 2026, dates: { "32/09/2026": {} } }),
  /no es válida/
);
assert.throws(
  () => validateDatedSpecialJson({ year: 2025, dates: { "01/01/2026": {} } }),
  /declara el año/
);
const circularRecords = [
  { id: "c1", kind: "circular", date: "11/09/2026", circulation: "D001", turn: "015", sourceName: "Os2026071BV.pdf", issues: [] },
  { id: "c2", kind: "circular", date: "11/09/2026", circulation: "A002", turn: "205", sourceName: "Os2026071BV.pdf", issues: [] }
];
const datedBlocked = buildDatedSpecialJson(circularRecords, datedBase, "review");
assert.equal(datedBlocked.conflicts.length, 1);
assert.equal(datedBlocked.payload.dates["01/01/2026"].A001, "001");
assert.equal(datedBlocked.payload.dates["11/09/2026"].D001, "313");
assert.equal(datedBlocked.payload.dates["11/09/2026"].A002, "205");
const datedReplaced = buildDatedSpecialJson(circularRecords, datedBase, "new");
assert.equal(datedReplaced.payload.dates["11/09/2026"].D001, "015");

const wrappedBase = validateDatedSpecialJson({
  year: 2026,
  date_format: "DD/MM/YYYY",
  dates: { "12/09/2026": { service: "400", circulations: { "A123": "118" } } }
});
const wrapped = buildDatedSpecialJson([
  { id: "c3", kind: "circular", date: "12/09/2026", circulation: "A902", turn: "R02", sourceName: "Os2026074BV.pdf", issues: [] }
], wrappedBase, "new");
assert.equal(wrapped.payload.dates["12/09/2026"].service, "400");
assert.equal(wrapped.payload.dates["12/09/2026"].circulations.A123, "118");
assert.equal(wrapped.payload.dates["12/09/2026"].circulations.A902, "R02");

console.log("OK · libro, circulares y combinación acumulativa del JSON especial");
