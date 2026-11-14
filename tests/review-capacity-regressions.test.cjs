"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSurfaceGuard, createEvalueTripwire, createOwnershipProbe } = require("../dist/index.js");

test("review: surface shared acyclic objects remain valid serializable JSON", () => {
  const shared = { title: "safe" };
  const payload = { first: shared, second: shared };
  assert.doesNotThrow(() => JSON.stringify(payload));
  for (const mode of ["advisory", "strip", "block"]) {
    const result = createSurfaceGuard({ mode }).inspectResponse("/shared", payload);
    assert.equal(result.truncated, false);
    assert.equal(result.ok, true);
  }
});

test("review: surface strip preserves sparse array length when removing nested fields", () => {
  const payload = [{ password: "secret", title: "safe" }];
  payload.length = 4;
  const result = createSurfaceGuard({ mode: "strip" }).inspectResponse("/array", payload);
  assert.equal(result.truncated, false);
  assert.equal(result.ok, true);
  assert.equal(result.sanitized.length, 4);
  assert.equal(JSON.stringify(result.sanitized), '[{"title":"safe"},null,null,null]');
});

test("review: evalue sparse record arrays reject without recording fabricated novelty", () => {
  const tripwire = createEvalueTripwire();
  const records = new Array(2);
  assert.throws(() => tripwire.observe({ cohortId: "sparse", records }), TypeError);
  assert.equal(tripwire.getSnapshot("sparse"), null);
});

test("review: ownership identity-cap gaps stay incomplete after capacity is released", () => {
  const probe = createOwnershipProbe({
    resolveOwner: id => id,
    maxIdentities: 1,
    windows: [{ windowSeconds: 100, minEvents: 2, minDistinctOwners: 2, minRatio: 0.75 }],
  });
  probe.observe("occupant", { objectId: "same", ts: 1 });
  for (let i = 0; i < 10; i++) assert.equal(probe.observe("returning", { objectId: "same", ts: 2 + i }).truncated, true);
  probe.reset("occupant");
  probe.observe("returning", { objectId: "new1", ts: 12 });
  const result = probe.observe("returning", { objectId: "new2", ts: 13 });
  // Full history has only 3 distinct owners in 12 touches. The retained
  // 2/2 fragment must never be presented as complete flag evidence.
  assert.equal(result.truncated, true);
  assert.equal(result.flagged, false);
  assert.equal(result.windows[0].scored, 0);
});

test("review: evalue validates the same record snapshot that it stores", () => {
  const tripwire = createEvalueTripwire();
  let reads = 0;
  const records = [];
  Object.defineProperty(records, "0", { enumerable: true, get() { reads++; return reads === 1 ? 1 : undefined; } });
  tripwire.observe({ cohortId: "snapshot", records });
  assert.equal(reads, 1);
  assert.equal(tripwire.observe({ cohortId: "snapshot", records: [1] }).novelRecords, 0);
});
