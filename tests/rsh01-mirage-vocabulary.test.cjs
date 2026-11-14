"use strict";
// RSH-01: createDecoyMirage accepts host field/feature vocabularies so
// decoy documents stop speaking the built-in credit-scoring dialect (a
// constant of the public source that fingerprints default documents).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sdk = require("../dist/index.js");

const mockReq = (path, headers = {}, method = "GET") => ({
  url: path.startsWith("http") ? path : `https://example.test${path}`,
  method,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
});

const HOST_FIELDS = ["dish_name", "price_vnd", "prep_minutes", "spice_level", "stock_count", "chef_station", "menu_section", "serving_size"];
const HOST_FEATURES = ["onlineOrdering", "tableBooking", "loyaltyPoints", "kitchenDisplay", "qrMenu", "deliveryTracking", "staffRoster", "wasteLog"];
const BUILTIN_FIELDS = ["account_status", "credit_limit", "risk_score", "utilization_ratio", "delinquency_count", "tenure_months", "payment_velocity", "exposure_band", "review_cycle", "segment_code", "region_code", "last_activity_at"];

async function collectDocs(mirage, paths) {
  const docs = [];
  for (const p of paths) {
    const r = await mirage.handle(mockReq(p));
    if (r && r.isDecoy) docs.push(r.body);
  }
  return docs;
}

test("mirage vocabulary: host field names replace the built-in dialect in schema/scoring docs", async () => {
  const paths = Array.from({ length: 24 }, (_, i) => `/api/v1/internal/probe-${i}`);
  const mirage = sdk.createDecoyMirage({ paths, fieldNames: HOST_FIELDS, featureNames: HOST_FEATURES });
  const docs = await collectDocs(mirage, paths);
  assert.ok(docs.length >= 12, `expected decoy docs, got ${docs.length}`);
  const usedNames = new Set();
  for (const d of docs) {
    if (d.document === "schema-registry") for (const f of d.models[0].fields) usedNames.add(f.name);
    if (d.document === "scoring-profile") for (const f of d.factors) usedNames.add(f.name.replace(/_weight$/, ""));
    if (d.document === "service-config") for (const k of Object.keys(d.features)) assert.ok(HOST_FEATURES.includes(k), `feature ${k} not in host vocabulary`);
  }
  assert.ok(usedNames.size > 0, "no field names collected");
  for (const n of usedNames) assert.ok(HOST_FIELDS.includes(n), `field ${n} not in host vocabulary`);
  for (const n of usedNames) assert.ok(!BUILTIN_FIELDS.includes(n), `built-in field ${n} leaked`);
});

test("mirage vocabulary: too-short vocabulary falls back to built-in defaults", async () => {
  const paths = Array.from({ length: 24 }, (_, i) => `/api/v1/internal/probe-${i}`);
  const mirage = sdk.createDecoyMirage({ paths, fieldNames: ["only_one"] });
  const docs = await collectDocs(mirage, paths);
  const usedNames = new Set();
  for (const d of docs) {
    if (d.document === "schema-registry") for (const f of d.models[0].fields) usedNames.add(f.name);
    if (d.document === "scoring-profile") for (const f of d.factors) usedNames.add(f.name.replace(/_weight$/, ""));
  }
  assert.ok(usedNames.size > 0);
  for (const n of usedNames) assert.ok(BUILTIN_FIELDS.includes(n), `unexpected field ${n}`);
});
