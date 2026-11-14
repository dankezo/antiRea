"use strict";
// BLA-02 shadow decoy graph: generation invariants, determinism, and
// the closure checker catching broken graphs. Lab record:
// rem293-lab/MEASURE-BLA02-IA02-2026-11-14.md (PASS-lab, frozen gates).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const sdk = require("../dist/index.js");

test("shadow graph: generated graph satisfies closure invariants", () => {
  const g = sdk.generateShadowDecoyGraph({ seed: "host-a" });
  assert.equal(g.authors.length, 5);
  assert.equal(g.series.length, 5);
  assert.equal(g.records.length, 60);
  const closure = sdk.verifyShadowGraphClosure(g);
  assert.deepEqual(closure, { ok: true, violations: [] });
  for (const a of g.authors) assert.equal(a.recordCount, 12);
  for (const s of g.series) assert.equal(s.recordCount, 12);
});

test("shadow graph: deterministic per seed, different seeds differ", () => {
  const a = sdk.generateShadowDecoyGraph({ seed: 42, categories: ["alpha", "beta"] });
  const b = sdk.generateShadowDecoyGraph({ seed: 42, categories: ["alpha", "beta"] });
  assert.deepEqual(a, b);
  const c = sdk.generateShadowDecoyGraph({ seed: 43, categories: ["alpha", "beta"] });
  assert.notDeepEqual(a.records.map((r) => r.tsDay), c.records.map((r) => r.tsDay));
});

test("shadow graph: host vocabulary is used, chain links are symmetric", () => {
  const g = sdk.generateShadowDecoyGraph({ seed: "x", authors: 2, seriesPerAuthor: 2, recordsPerSeries: 3, categories: ["loans", "cards"] });
  assert.equal(g.records.length, 12);
  for (const r of g.records) assert.ok(r.category === "loans" || r.category === "cards");
  const byId = new Map(g.records.map((r) => [r.id, r]));
  for (const r of g.records) {
    if (r.nextId) assert.equal(byId.get(r.nextId).prevId, r.id);
    if (r.prevId) assert.equal(byId.get(r.prevId).nextId, r.id);
  }
  assert.equal(sdk.verifyShadowGraphClosure(g).ok, true);
});

test("shadow graph: closure checker catches tampering", () => {
  const g = sdk.generateShadowDecoyGraph({ seed: "y" });
  const brokenCount = structuredClone(g);
  brokenCount.series[0].recordCount = 999;
  assert.equal(sdk.verifyShadowGraphClosure(brokenCount).ok, false);
  const brokenLink = structuredClone(g);
  brokenLink.records[1].prevId = null;
  assert.equal(sdk.verifyShadowGraphClosure(brokenLink).ok, false);
  const brokenRef = structuredClone(g);
  brokenRef.records[0].authorId = "nobody";
  assert.equal(sdk.verifyShadowGraphClosure(brokenRef).ok, false);
});
