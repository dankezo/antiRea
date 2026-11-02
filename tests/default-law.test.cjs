const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * The 09:44 default law (Danny, 02/11/2026): enforcement is ON at the
 * friction tier by default for inferred cohorts; hard consequences
 * stay code-forbidden for them; host-declared protected subjects
 * receive zero inferred-evidence consequences. These tests pin the
 * DEFAULTS - most construct engines with no mode/opt-in arguments.
 */

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });
const INFERRED_GATED = { origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true };

/** Four identities slicing abutting ranges, 40 records each: exact
 * union at the crossing is 160 (above the 150 consequence floor),
 * per-member sizes stay below the tiling gate, crossing is
 * adjacency-driven - the same shape as cusum-tripwire.test.cjs. */
async function feedSlicers(tw, names = ['a', 'b', 'c', 'd'], ts = 1_000_000) {
  const ranges = [[0, 1000], [1005, 2000], [2010, 3000], [3010, 4000]];
  const decisions = [];
  for (let i = 0; i < 4; i++) {
    decisions.push(await tw.observe({
      type: 'list', identity: `account:${names[i]}`,
      predicate: PRED(ranges[i][0], ranges[i][1]), recordIds: ids(ranges[i][0], 40), ts: ts + i * 100,
    }));
  }
  return decisions;
}

/** The polite+NAT shape from the v24 classic test: six identities,
 * abutting narrow predicates, 5 disjoint records each - union 20 at
 * the crossing, far below the consequence floor. */
async function feedNatCohort(tw, ts = 1_000_000) {
  const decisions = [];
  const names = ['nat1', 'nat2', 'nat3', 'nat4', 'nat5', 'polite'];
  for (let i = 0; i < names.length; i++) {
    const min = i * 45;
    decisions.push(await tw.observe({
      type: 'list', identity: `account:${names[i]}`,
      predicate: PRED(min, min + 40), recordIds: ids(min, 5), ts: ts + i * 100,
    }));
  }
  return decisions;
}

/* ---------------- 1. friction is the default ------------------------ */

test('default law: CUSUM ships in enforce mode - an eligible inferred crossing gets step_up with NO opt-in', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  const decisions = await feedSlicers(tw);
  const last = decisions[decisions.length - 1];
  assert.equal(last.crossed, true);
  assert.equal(last.action, 'step_up');
  assert.equal(last.consequenceEligible, true);
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.flagged, true);
  // Step-up is the tripwire's ceiling on uncalibrated tables: the
  // shared campaign ceiling still cannot engage by default.
  assert.equal(snapshot.ceilingActive, false);
});

test('default law: an inferred cohort may be stepped down by default - softly, to the 500 floor', () => {
  assert.equal(sdk.SOFT_BUDGET_FLOOR_RECORDS, 500);
  const clamp = sdk.clampEnforcement('budget_step_down', INFERRED_GATED);
  assert.equal(clamp.action, 'budget_step_down');
  assert.equal(clamp.clamped, false);
  assert.equal(clamp.budgetFloorRecords, 500);
  // A demand below the floor lands AT the floor.
  const floored = sdk.softBudgetStepDown(2000, 100, INFERRED_GATED);
  assert.equal(floored.limit, 500);
  assert.equal(floored.floored, true);
  assert.equal(floored.applied, true);
  // A demand above the floor lands where it was aimed.
  const aimed = sdk.softBudgetStepDown(2000, 800, INFERRED_GATED);
  assert.equal(aimed.limit, 800);
  assert.equal(aimed.floored, false);
  // An already-lower limit (e.g. a direct-evidence taint at 200) is
  // never raised by a step-down.
  const tainted = sdk.softBudgetStepDown(200, 0, INFERRED_GATED);
  assert.equal(tainted.limit, 200);
  assert.equal(tainted.applied, false);
  // Ungated inference gets no step-down at all.
  const ungated = sdk.softBudgetStepDown(2000, 100, { origin: 'inferred', calibrationTier: 'audit_only' });
  assert.equal(ungated.limit, 2000);
  assert.equal(ungated.applied, false);
});

test('default law: herd graduated_only defaults to friction (step_up + soft step-down), zero price, no ladder', () => {
  const resp = sdk.defaultHerdBandResponse('graduated_only', INFERRED_GATED);
  assert.equal(resp.stepUp, true);
  assert.equal(resp.budgetStepDownFloorRecords, 500);
  assert.equal(resp.ladder, false);
  assert.equal(resp.pricePerRecord, 0);
  // Even the cut band defaults to friction for an inferred cohort on
  // uncalibrated evidence; the ladder needs a declared cohort or a
  // ceiling-tier manifest.
  const cut = sdk.defaultHerdBandResponse('budget_cut_supported', INFERRED_GATED);
  assert.equal(cut.ladder, false);
  assert.equal(cut.stepUp, true);
  assert.equal(cut.budgetStepDownFloorRecords, 500);
  const declared = sdk.defaultHerdBandResponse('budget_cut_supported', {
    origin: 'host_declared', calibrationTier: 'audit_only',
  });
  assert.equal(declared.ladder, true);
  assert.equal(sdk.applyHerdLadder({ setOverride: () => {} }, { band: 'graduated_only', members: ['account:x'] }, { memberLimit: 100 }).applied, false);
});

/* ------------- 2. hard consequences stay forbidden ------------------ */

test('default law: an inferred cohort can never reach hard ceiling or a zero budget, even when config demands it', () => {
  for (const tier of ['audit_only', 'step_down']) {
    const ctx = { origin: 'inferred', calibrationTier: tier, tripwireGated: true };
    for (const demanded of ['hard_ceiling', 'deny']) {
      const clamp = sdk.clampEnforcement(demanded, ctx);
      assert.equal(clamp.action, 'budget_step_down', `${demanded} at ${tier}`);
      assert.equal(clamp.clamped, true);
      assert.equal(clamp.budgetFloorRecords, 500);
    }
    const toZero = sdk.softBudgetStepDown(2000, 0, ctx);
    assert.equal(toZero.limit, 500, `budget to zero at ${tier} must land on the floor`);
  }
  // Cold pricing on the graduated band remains a startup error.
  const priced = sdk.validateHerdResponseConfig({ band: 'graduated_only', coldFetchMultiplier: 5 });
  assert.equal(priced.valid, false);
  assert.equal(sdk.herdBandPrice('graduated_only'), 0);
  assert.equal(sdk.herdBandPrice('budget_cut_supported'), 0);
});

/* ------------- 3. protected subjects: zero consequences ------------- */

test('default law: a protected subject inside a crossing cohort receives exactly zero consequences; unprotected members still get step_up', async () => {
  const registry = sdk.createProtectedCohortRegistry();
  registry.declareProtected(['account:comp1'], { reason: 'quarterly compliance review' });
  assert.equal(registry.isProtected('account:comp1'), true);
  assert.equal(registry.isProtected('account:b'), false);

  const tw = sdk.createCusumTripwire({ alpha: 0.05, isProtected: id => registry.isProtected(id) });
  const decisions = await feedSlicers(tw, ['comp1', 'b', 'c', 'd']);
  // The crossing still happens and the unprotected actor gets step_up.
  assert.equal(decisions[decisions.length - 1].action, 'step_up');
  // Telemetry is intact: the protected subject is a full member.
  const snapshot = await tw.snapshotFor('account:comp1');
  assert.equal(snapshot.flagged, true);
  assert.ok(snapshot.members.includes('account:comp1'));
  assert.deepEqual(snapshot.protectedMembers, ['account:comp1']);
  assert.ok(snapshot.unionRecords >= 160);
  // The protected subject's own next decision is telemetry-only.
  const own = await tw.observe({
    type: 'list', identity: 'account:comp1', predicate: PRED(0, 1000), recordIds: ids(0, 5), ts: 1_001_000,
  });
  assert.equal(own.flagged, true);
  assert.equal(own.action, 'logged');
  assert.equal(own.protectedSubject, true);
  assert.match(own.clampedReason, /protected subject/);
  // Pre-serve: protected passes through whole; an unprotected member
  // is bucket-paced by the same flag.
  assert.deepEqual(await tw.checkServe('account:comp1', 100_000), { allowed: 100_000 });
  const paced = await tw.checkServe('account:b', 100_000);
  assert.ok(paced.allowed <= 150);
  assert.equal(paced.reason, 'campaign_bucket');
});

test('default law: the registry gates single subjects, partitions target lists, and lapses on expiry', () => {
  let clock = 1_000_000;
  const registry = sdk.createProtectedCohortRegistry({ now: () => clock });
  const decl = registry.declareProtected('account:auditor', { reason: 'agreed pentest window', expiresAtMs: 2_000_000 });
  assert.equal(decl.subjects.length, 1);
  assert.equal(registry.declarations().length, 1);
  assert.deepEqual(registry.protectedSubjects(), ['account:auditor']);

  const gated = registry.guardInferredConsequence('account:auditor', 'step_up');
  assert.equal(gated.action, 'observe');
  assert.equal(gated.protectedSubject, true);
  assert.equal(gated.clamped, true);
  const open = registry.guardInferredConsequence('account:mallory', 'step_up');
  assert.equal(open.action, 'step_up');
  assert.equal(open.protectedSubject, false);

  const part = registry.partitionConsequenceTargets(['account:auditor', 'account:b', 'account:c']);
  assert.deepEqual(part.applicable, ['account:b', 'account:c']);
  assert.deepEqual(part.protectedSubjects, ['account:auditor']);

  clock = 2_000_001; // past the declared window: protection lapses
  assert.equal(registry.isProtected('account:auditor'), false);
  assert.equal(registry.guardInferredConsequence('account:auditor', 'step_up').action, 'step_up');
});

/* ------------- 4. the floor still gates the new default ------------- */

test('default law: below the consequence floor, the new enforce default is still telemetry-only', async () => {
  const flags = [];
  const tw = sdk.createCusumTripwire({ alpha: 0.05, onCampaignFlag: snap => flags.push(snap) });
  const decisions = await feedNatCohort(tw);
  const crossing = decisions[3];
  assert.equal(crossing.crossed, true);
  assert.equal(crossing.flagged, true);
  assert.equal(flags.length, 1);
  assert.equal(crossing.action, 'logged');
  assert.equal(crossing.consequenceEligible, false);
  assert.match(crossing.clampedReason, /consequence floor/);
  assert.deepEqual(await tw.checkServe('account:nat1', 50), { allowed: 50 });
});

/* ------------- 5. IP alone creates no consequence ------------------- */

test('default law: many identities sharing one IP, with no extraction behavior, never flag in the herd detector', () => {
  const flags = [];
  const herd = sdk.createHerdDetector({ onFlag: snap => flags.push(snap) });
  const base = 1_700_000_000_000;
  const shared = ids(1001, 10).map(n => `ACC-${n}`);
  for (let k = 0; k < 6; k++) {
    const identity = `account:user${k + 1}@corp.dev`;
    herd.observe({ type: 'signup', identity, ip: '203.0.113.7', ts: base + k * 60_000 });
    herd.observe({ type: 'login', identity, ip: '203.0.113.7', ts: base + k * 60_000 + 1000 });
    // Everyone browses the SAME first page: maximal overlap, minimal
    // coverage - the NAT/onboarding shape, not an extraction shape.
    herd.observe({ type: 'list', identity, ip: '203.0.113.7', recordIds: shared, ts: base + k * 60_000 + 2000 });
  }
  assert.equal(flags.length, 0);
  for (const group of herd.groups()) assert.equal(group.flagged, false);
});

test('default law: the CUSUM engine has no IP input - unrelated identities on disjoint ranges never form a cohort', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  for (let round = 0; round < 2; round++) {
    const a = await tw.observe({ type: 'list', identity: 'account:one', predicate: PRED(0, 100), recordIds: ids(0, 5), ts: 1_000_000 + round * 1000 });
    const b = await tw.observe({ type: 'list', identity: 'account:two', predicate: PRED(5000, 5100), recordIds: ids(5000, 5), ts: 1_000_500 + round * 1000 });
    assert.equal(a.cohortId, null);
    assert.equal(b.cohortId, null);
  }
  assert.equal(await tw.snapshotFor('account:one'), null);
  assert.equal(await tw.snapshotFor('account:two'), null);
});
