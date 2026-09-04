import assert from "node:assert/strict";
import {
  detectAssignments,
  isSpecialService,
  normalizeCirculation,
  normalizeTurn,
  parseTurnExpression
} from "../assets/parser.js";
import { buildJson, mergeSpecialJson, validateSpecialJson } from "../assets/exporter.js";

assert.equal(normalizeCirculation("F012").value, "F012");
assert.equal(normalizeCirculation("H801"), null);
assert.equal(normalizeCirculation("F808"), null);
assert.equal(normalizeTurn("S02").value, "S02");
assert.equal(normalizeTurn("RR8").value, "RR8");
assert.equal(isSpecialService("601"), true);
assert.equal(isSpecialService("500"), false);

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

console.log("OK · parser, exportación y combinación de servicios especiales");
