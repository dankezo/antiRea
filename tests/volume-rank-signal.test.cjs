"use strict";
// RECOMB-04 VOLUME-RANK (PASS-lab C444) - the frozen R2 rule: an identity
// flags iff >= 2 of its RARE cells rank in the top 5% of ALL cells by
// EB05 score (rank descending, cutoff floor(nCells * frac), ties keep
// input order); strata by total volume with the frozen log-space
// boundaries 63.2 / 632.5. These tests pin the rule mechanics on a
// hand-built 100-cell population; the EB05 fit itself is host-side.
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyVolumeRankRule, volumeStratumOf } = require("../dist/index.js");

function buildCells() {
  const cells = [];
  const push = (identityId, score, rare) => cells.push({ identityId, score, rare });
  // A: two rare cells at ranks 0 and 1 (inside top 5% AND top 10%).
  push("A", 1000, true);
  push("A", 990, true);
  push("A", 500, false);
  // B: one rare at rank 2 (top 5%), second rare at rank 5 (top 10% only).
  push("B", 980, true);
  push("B", 950, true);
  push("B", 100, true);
  // Fillers holding ranks 3, 4 (top 5%) and 6..9 (top 10%).
  push("F1", 970, false);
  push("F2", 960, false);
  push("F3", 940, false);
  push("F4", 930, false);
  push("F5", 920, false);
  push("F6", 910, false);
  // C: rare cells, all far below the top slices.
  push("C", 90, true);
  push("C", 80, true);
  push("C", 70, false);
  // Remaining cells: low-score non-rare fillers, one per identity.
  for (let i = 0; i < 85; i++) push("FILL-" + i, 60 - i * 0.1, false);
  return cells;
}

const VOLUMES = { A: 100, B: 10, C: 5000 };
for (let i = 1; i <= 6; i++) VOLUMES["F" + i] = 100;
for (let i = 0; i < 85; i++) VOLUMES["FILL-" + i] = 100;

test("R2-rank5: A flags with 2 rare in top 5%, B does not with exactly 1, C does not with 0", () => {
  const cells = buildCells();
  assert.equal(cells.length, 100);
  const r = applyVolumeRankRule({ cells, identityVolumes: VOLUMES });
  assert.equal(r.cellCount, 100);

  assert.equal(r.identities.A.rareCellCount, 2);
  assert.equal(r.identities.A.rareCellsInTop, 2);
  assert.equal(r.identities.A.flagged, true);

  assert.equal(r.identities.B.rareCellsInTop, 1);
  assert.equal(r.identities.B.flagged, false);

  assert.equal(r.identities.C.rareCellsInTop, 0);
  assert.equal(r.identities.C.flagged, false);
});

test("descriptive R2-rank10 is a superset of R2-rank5 (B flags only at 10%)", () => {
  const r = applyVolumeRankRule({ cells: buildCells(), identityVolumes: VOLUMES });
  assert.equal(r.identities.B.rareCellsInTopDescriptive, 2);
  assert.equal(r.identities.B.flaggedDescriptive, true);
  assert.equal(r.identities.A.flaggedDescriptive, true);
  assert.equal(r.identities.C.flaggedDescriptive, false);
  for (const id of Object.keys(r.identities)) {
    const e = r.identities[id];
    assert.ok(e.rareCellsInTopDescriptive >= e.rareCellsInTop, id);
    if (e.flagged) assert.equal(e.flaggedDescriptive, true, id);
  }
});

test("strata assignment: volumes 10 / 100 / 5000 -> LOW / MID / HIGH, frozen boundaries inclusive to MID", () => {
  const r = applyVolumeRankRule({ cells: buildCells(), identityVolumes: VOLUMES });
  assert.equal(r.identities.B.stratum, "LOW");
  assert.equal(r.identities.A.stratum, "MID");
  assert.equal(r.identities.C.stratum, "HIGH");

  assert.equal(volumeStratumOf(10), "LOW");
  assert.equal(volumeStratumOf(63.19), "LOW");
  assert.equal(volumeStratumOf(63.2), "MID");
  assert.equal(volumeStratumOf(100), "MID");
  assert.equal(volumeStratumOf(632.5), "MID");
  assert.equal(volumeStratumOf(632.51), "HIGH");
  assert.equal(volumeStratumOf(5000), "HIGH");
  assert.equal(volumeStratumOf(NaN), null);
});

test("summary counts per stratum for both fractions; unknown volume lands in NONE", () => {
  const r = applyVolumeRankRule({ cells: buildCells(), identityVolumes: VOLUMES });
  assert.equal(r.summary.MID.flagged, 1); // A
  assert.equal(r.summary.LOW.flagged, 0);
  assert.equal(r.summary.LOW.flaggedDescriptive, 1); // B
  assert.equal(r.summary.HIGH.identities, 1); // C
  assert.equal(r.summary.HIGH.flagged, 0);

  const r2 = applyVolumeRankRule({
    cells: [{ identityId: "ghost", score: 1, rare: true }],
    identityVolumes: {},
  });
  assert.equal(r2.identities.ghost.stratum, null);
  assert.equal(r2.summary.NONE.identities, 1);
});

test("invalid top fraction throws RangeError", () => {
  assert.throws(
    () => applyVolumeRankRule({ cells: [], identityVolumes: {}, topFrac: 0 }),
    RangeError,
  );
  assert.throws(
    () => applyVolumeRankRule({ cells: [], identityVolumes: {}, topFracDescriptive: 1.5 }),
    RangeError,
  );
});
