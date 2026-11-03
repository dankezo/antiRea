'use strict';

/*
 * C6-1 regression tests (antiRea 2.7.0 pre-release audit cleanup,
 * cluster A): declared-cohort routing for family F is a PER-EVENT
 * property, not a per-identity latch.
 *
 * Contract under test (input-space-coverage.ts, hard condition 2):
 * - A query whose event carries a DECLARED cohort id is accumulated
 *   into the identity's declared-cohort (bulk) lane; a query without
 *   one - or with a non-declared cohort id - goes to the casual lane.
 * - The lanes keep SEPARATE stream state per identity/feature:
 *   counters, distinct sets and checkpoints are per lane, so a
 *   checkpoint closes on a lane's own item count, never on the
 *   identity's mixed total.
 * - Routing NEVER latches and is NEVER retroactive: one tagged query
 *   does not move earlier or later untagged queries into the bulk
 *   lane, and checkpoints already emitted are never re-scored.
 * - A resource event's cohortId registers cohort membership only; it
 *   does not route the identity's feature queries.
 * - evaluateIdentity exposes the per-lane breakdown on
 *   signal.feature.lanes; the top-level feature signal is the
 *   reporting lane (a flagged lane first, else the strongest scored
 *   lane, else an uncalibrated lane, else insufficient data).
 *
 * The audit repro (19 untagged sweep queries + the checkpoint-closing
 * 20th tagged 'bulk') must therefore close NO checkpoint at all, and
 * the following untagged queries must be scored - and flag - in the
 * casual lane.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInputSpaceCoverage } = require('../dist/index.js');

const NRES = 2000;
const M = 100000;
const dirId = (r) => 47 * r + 13;
const isPop = (id) => {
  const d = (id - 13) / 47;
  return Number.isInteger(d) && d >= 0 && d < NRES;
};

const surface = () => ({
  features: [{ featureId: 'directory', spaceSize: M, isPopulated: isPop }],
  resources: { spaceSize: NRES, tailRank: 1000 },
  declaredCohorts: ['bulk'],
});

/* Casual legit shape (audit repro's train): clustered populated hits. */
function casualTrainStreams(nStreams) {
  const train = [];
  for (let s = 0; s < nStreams; s++) {
    const queries = [];
    for (let i = 0; i < 40; i++) {
      const r = (s * 97 + i * 37) % 500;
      queries.push({ featureId: 'directory', inputId: dirId(r), hit: true });
    }
    train.push({ queries, events: [] });
  }
  return train;
}

/* Bulk shape: 45% populated hits, 55% clean misses (id % 47 === 0 is
 * never populated), almost all distinct - deterministic per stream. */
function bulkQueries(s, n) {
  const qs = [];
  for (let j = 0; j < n; j++) {
    if (j % 20 < 9) {
      qs.push({ inputId: dirId((s * 131 + j * 17) % NRES), hit: true });
    } else {
      qs.push({ inputId: 47 * ((s * 57 + j * 29) % 1900), hit: false });
    }
  }
  return qs;
}

function makeInst({ withBulk = false } = {}) {
  const inst = createInputSpaceCoverage({ surface: surface(), minTrainStreams: 5 });
  inst.fitCalibration(casualTrainStreams(10));
  if (withBulk) {
    const bulkTrain = [];
    for (let s = 0; s < 12; s++) {
      bulkTrain.push(bulkQueries(s, 120).map((q) => ({ featureId: 'directory', inputId: q.inputId, hit: q.hit })));
    }
    inst.fitBulkCalibration(bulkTrain);
  }
  return inst;
}

const feedSweep = (inst, identity, from, to, cohortId) => {
  let last = null;
  for (let i = from; i < to; i++) {
    last = inst.observeQuery({
      identity,
      featureId: 'directory',
      inputId: i,
      hit: isPop(i),
      ...(cohortId ? { cohortId } : {}),
    });
  }
  return last;
};

test('C6-1: a single tagged query at the checkpoint boundary relabels nothing (no latch, no retroactivity)', () => {
  const inst = makeInst();
  // 19 untagged sweep queries, then the 20th (identity-total) query
  // tagged with the declared cohort. Per-lane state: casual has 19,
  // bulk has 1 - NEITHER lane is at a checkpoint, so no checkpoint
  // may close and no signal may be emitted.
  let boundary = null;
  for (let i = 0; i < 20; i++) {
    const ev = { identity: 'mixed', featureId: 'directory', inputId: i, hit: isPop(i) };
    if (i === 19) ev.cohortId = 'bulk';
    boundary = inst.observeQuery(ev);
  }
  assert.equal(boundary.checkpoint, false, 'mixed totals must not close a checkpoint in either lane');
  assert.equal(boundary.signal, undefined);

  // The next untagged query is the casual lane's own 20th: it closes
  // the CASUAL checkpoint and the sweep flags there - the lane the
  // first 19 queries were actually issued under.
  const cp = inst.observeQuery({ identity: 'mixed', featureId: 'directory', inputId: 20, hit: isPop(20) });
  assert.equal(cp.checkpoint, true);
  assert.equal(cp.signal.feature.calibration, 'casual');
  assert.equal(cp.signal.feature.status, 'scored');
  assert.equal(cp.signal.feature.flagged, true);

  // 19 more untagged queries bring the casual lane to its second
  // checkpoint (36); routing must STILL be casual (audit C6-2: the
  // pre-fix code reported declared_cohort / uncalibrated forever).
  let second = null;
  for (let i = 21; i < 40; i++) {
    const obs = inst.observeQuery({ identity: 'mixed', featureId: 'directory', inputId: i, hit: isPop(i) });
    if (obs.checkpoint) second = obs;
  }
  assert.ok(second, 'casual lane must close its second checkpoint at its own 36th query');
  assert.equal(second.signal.feature.calibration, 'casual');
  const sig = inst.evaluateIdentity('mixed');
  assert.equal(sig.feature.calibration, 'casual');
  assert.equal(sig.feature.status, 'scored');
  assert.equal(sig.feature.flagged, true);
  // The bulk lane holds exactly the one tagged query: present in the
  // breakdown, with no checkpoint and no contamination.
  assert.ok(sig.feature.lanes, 'per-lane breakdown must be exposed');
  assert.equal(sig.feature.lanes.declared_cohort.status, 'insufficient_data');
  assert.equal(sig.feature.lanes.declared_cohort.checkpoints, 0);
  assert.equal(sig.feature.lanes.casual.flagged, true);
});

test('C6-1: a half-tagged identity is scored correctly in BOTH lanes', () => {
  const inst = makeInst({ withBulk: true });
  // Bulk lane first: a bulk-shaped stream cloned from bulk train
  // stream 3, every query tagged. It must sit inside the bulk
  // calibration's band (the same streams flag ~100% against casual).
  let bulkCp = null;
  for (const q of bulkQueries(3, 40)) {
    const obs = inst.observeQuery({ identity: 'dual', featureId: 'directory', inputId: q.inputId, hit: q.hit, cohortId: 'bulk' });
    if (obs.checkpoint) bulkCp = obs;
  }
  assert.ok(bulkCp, 'bulk lane must close its own checkpoint at 20 bulk queries');
  assert.equal(bulkCp.signal.feature.calibration, 'declared_cohort');
  assert.equal(bulkCp.signal.feature.status, 'scored');
  assert.equal(bulkCp.signal.feature.flagged, false);

  // Casual lane: an untagged sequential sweep flags at its own first
  // checkpoint - unaffected by the 40 bulk queries before it.
  const sweepCp = feedSweep(inst, 'dual', 0, 20);
  assert.equal(sweepCp.checkpoint, true);
  assert.equal(sweepCp.signal.feature.calibration, 'casual');
  assert.equal(sweepCp.signal.feature.flagged, true);
  assert.equal(sweepCp.signal.feature.firstFlagAt, 20);

  const sig = inst.evaluateIdentity('dual');
  assert.equal(sig.flagged, true);
  assert.equal(sig.feature.lanes.casual.flagged, true);
  assert.equal(sig.feature.lanes.casual.firstFlagAt, 20);
  assert.equal(sig.feature.lanes.declared_cohort.status, 'scored');
  assert.equal(sig.feature.lanes.declared_cohort.flagged, false);
  assert.equal(sig.feature.lanes.declared_cohort.checkpoints, 2);
});

test('C6-1: switching cohortId mid-stream does not drag the past into the new lane', () => {
  const inst = makeInst({ withBulk: true });
  for (const q of bulkQueries(5, 20)) {
    inst.observeQuery({ identity: 'switcher', featureId: 'directory', inputId: q.inputId, hit: q.hit, cohortId: 'bulk' });
  }
  const before = inst.evaluateIdentity('switcher');
  assert.equal(before.feature.lanes.declared_cohort.checkpoints, 1);
  const bulkEvidenceBefore = before.feature.lanes.declared_cohort.evidence;

  // Now the identity switches to untagged sweeping. Its casual lane
  // starts from zero and flags at its own query 20; the bulk lane's
  // evidence and checkpoint count must be exactly what they were.
  feedSweep(inst, 'switcher', 0, 20);
  const after = inst.evaluateIdentity('switcher');
  assert.equal(after.feature.lanes.casual.flagged, true);
  assert.equal(after.feature.lanes.casual.firstFlagAt, 20);
  assert.equal(after.feature.lanes.declared_cohort.checkpoints, 1);
  assert.equal(after.feature.lanes.declared_cohort.evidence, bulkEvidenceBefore);
});

test('C6-1: a non-declared cohortId stays in the casual lane', () => {
  const inst = makeInst();
  const cp = feedSweep(inst, 'herd-member', 0, 20, 'herd-x');
  assert.equal(cp.checkpoint, true);
  assert.equal(cp.signal.feature.calibration, 'casual');
  assert.equal(cp.signal.feature.flagged, true);
  // And the cohort-max scope still sees the cohort (registration is
  // membership, separate from family-F lane routing).
  const cohortSig = inst.evaluateCohort('herd-x');
  assert.equal(cohortSig.scope, 'cohort');
});

test('C6-1: a resource event carrying a declared cohortId does not route later queries', () => {
  const inst = makeInst();
  const r = inst.observeResource({ identity: 'res-first', resourceId: 7, cohortId: 'bulk' });
  assert.equal(r.status, 'recorded');
  const cp = feedSweep(inst, 'res-first', 0, 20);
  assert.equal(cp.signal.feature.calibration, 'casual');
  assert.equal(cp.signal.feature.flagged, true);
});
