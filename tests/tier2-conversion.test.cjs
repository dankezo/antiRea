const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createTier2Conversion,
  Tier2ConversionError,
} = require('../dist/tier2-active/tier2-conversion.js');
const { SOFT_BUDGET_FLOOR_RECORDS } = require('../dist/tier2-active/enforcement-tiering.js');

// ---------------------------------------------------------------------------
// Tier-2 conversion (antiRea 3.0 Item 1) - B-G2 decision-fidelity tests.
// Each named test pins one locked decision of the build registration
// (farmgate-2026-11-16/REGISTRATION-TIER2-CONVERSION.md; parent
// REGISTRATION-C27-C35-ENFORCEMENT.md, Danny 2026-11-04: 1A/2A/5A):
//   1A - identity-level SOFT step-down, floored at 500, never a hard block;
//   2A - C35 first touch = taint + step_up, V-C self-disarm and
//        retroactive void are mandatory, not options;
//   5A - alpha-wealth fleet budget: exhaustion falls back to observe-only.
// The B-G1 lab regression (29 checks) lives in the study tree as
// c27c35-enf-lab/test-conversion-sdk.cjs, run against this module.
// ---------------------------------------------------------------------------

const FLOOR = SOFT_BUDGET_FLOOR_RECORDS; // 500

function enabledLayer(extra = {}) {
  return createTier2Conversion({ enabled: true, baseBudgetRecords: 2000, alphaCap: 1000, ...extra });
}

function driveToTier2(layer, id) {
  layer.c27Flag(id, { epoch: 1, novel90: 420, ageDays: 90 });
  return layer.c27Flag(id, { epoch: 2, novel90: 420, ageDays: 90, cohortUnion: 150 });
}

test('persistence: single flag -> step_up only', () => {
  const layer = enabledLayer();
  const r = layer.c27Flag('solo', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(r.tier, 1);
  assert.equal(r.reason, 'tier1: single flag');
  const snap = layer.snapshot('solo');
  assert.equal(snap.enforcement, 'step_up');
  // Step-up alone never moves the budget.
  assert.equal(snap.effectiveBudgetRecords, 2000);
});

test('persistence: persistent + corroborated -> step_down', () => {
  const layer = enabledLayer();
  const r = driveToTier2(layer, 'persist');
  assert.equal(r.tier, 2);
  assert.equal(r.reason, 'tier2: persistent + corroborated');
  const snap = layer.snapshot('persist');
  assert.equal(snap.enforcement, 'budget_step_down');
  assert.equal(snap.effectiveBudgetRecords, FLOOR);
});

test('1A floor: stepped budget never below 500', () => {
  // A tier-2 step-down against a range of host bases: the result is
  // always >= 500 whenever the base is, lands exactly on the floor
  // when the target is the floor, and is never 0 (no hard block).
  for (const base of [500, 501, 600, 2000, 100000]) {
    const layer = enabledLayer({ baseBudgetRecords: base, stepDownTargetRecords: 0 });
    driveToTier2(layer, 'floored');
    const budget = layer.effectiveBudget('floored');
    assert.ok(budget >= FLOOR, `base ${base}: stepped budget ${budget} must stay >= ${FLOOR}`);
    assert.equal(budget, FLOOR);
    assert.ok(budget > 0, 'a stepped budget is friction, never a hard block');
  }
  // A base already below the floor is neither raised nor cut further.
  const low = enabledLayer({ baseBudgetRecords: 300 });
  driveToTier2(low, 'lowbase');
  assert.equal(low.effectiveBudget('lowbase'), 300);
  // Tier 0/1 identities keep their full base budget.
  const layer = enabledLayer();
  layer.c27Flag('untouched', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(layer.effectiveBudget('untouched'), 2000);
});

test('corroboration independence: same-family re-flag does not trigger step-down', () => {
  // Two C27 flags in distinct epochs = persistence, NOT corroboration.
  const layer = enabledLayer();
  layer.c27Flag('samefam', { epoch: 1, novel90: 420, ageDays: 90 });
  const r = layer.c27Flag('samefam', { epoch: 2, novel90: 420, ageDays: 90 });
  assert.equal(r.tier, 1);
  assert.equal(r.reason, 'tier1: no corroboration');
  // A recorded corroboration from the SAME family (c27) changes nothing.
  const layer2 = enabledLayer();
  layer2.recordCorroboration('samefam2', { family: 'c27' });
  layer2.c27Flag('samefam2', { epoch: 1, novel90: 420, ageDays: 90 });
  const r2 = layer2.c27Flag('samefam2', { epoch: 2, novel90: 420, ageDays: 90 });
  assert.equal(r2.tier, 1);
  // A DIFFERENT family's signal inside the window does corroborate.
  const layer3 = enabledLayer();
  layer3.recordCorroboration('diffam', { family: 'cusum' });
  layer3.c27Flag('diffam', { epoch: 1, novel90: 420, ageDays: 90 });
  const r3 = layer3.c27Flag('diffam', { epoch: 2, novel90: 420, ageDays: 90 });
  assert.equal(r3.tier, 2);
});

test('2A self-disarm: taint expires on the V-C schedule and the ledger clears 90 days after last touch', () => {
  const layer = enabledLayer();
  const touch = layer.c35Touch('tainted', { decoy: 'D1' });
  assert.equal(touch.taint, true);
  assert.equal(touch.tier, 1);
  assert.ok(layer.snapshot('tainted').c35Delta > 0);
  assert.ok(layer.cohortState().cohortDeltaTotal > 0);
  // A later C27 flag must NOT extend the taint's life (V-C split clock):
  // the taint clock is the TOUCH clock, not the flag clock.
  layer.advanceDays(80);
  layer.c27Flag('tainted', { epoch: 1, novel90: 420, ageDays: 90 });
  layer.advanceDays(10); // 90 days after the touch: not yet past the schedule
  assert.equal(layer.snapshot('tainted').taint, true);
  layer.advanceDays(1); // 91 days after the last touch: V-C expiry fires
  const snap = layer.snapshot('tainted');
  assert.equal(snap.taint, false);
  // The ledger clears with the taint: no live decoys, no live delta,
  // and the identity's cohort-delta contribution is gone.
  assert.equal(snap.c35Distinct, 0);
  assert.equal(snap.c35Delta, 0);
  assert.equal(layer.cohortState().cohortDeltaTotal, 0);
  assert.equal(layer.cohortState().unionLiveSize, 0);
});

test('2A retroactive void: a voided touch removes its delta and recomputes the tier', () => {
  const layer = enabledLayer();
  layer.c35Touch('voided', { decoy: 'D1' });
  layer.c35Touch('voided', { decoy: 'D2' });
  const t3 = layer.c35Touch('voided', { decoy: 'D3', cohortUnion: 150 });
  assert.equal(t3.tier, 2);
  const totalBefore = layer.cohortState().cohortDeltaTotal;
  const deltaBefore = layer.snapshot('voided').c35Delta;
  const attrBefore = layer.attributionLog.length;
  // Void exactly one decoy: exactly that touch's delta (ln5, a repeat
  // touch) leaves the identity AND the cohort total - nobody else's.
  const v = layer.voidTouch('voided', 'D2');
  assert.equal(v.voided, 1);
  assert.ok(Math.abs(v.voidedDelta - Math.log(5)) < 1e-9);
  assert.ok(Math.abs(layer.snapshot('voided').c35Delta - (deltaBefore - Math.log(5))) < 1e-9);
  assert.ok(Math.abs(layer.cohortState().cohortDeltaTotal - (totalBefore - Math.log(5))) < 1e-9);
  // With only 2 distinct live decoys and the union corroboration gone
  // from live evidence, the recomputed tier falls back to step_up -
  // and the fall is in the attribution log (no record, no action).
  assert.equal(v.tier, 1);
  assert.equal(layer.snapshot('voided').tier, 1);
  assert.ok(layer.attributionLog.length > attrBefore);
  const rec = layer.attributionLog[layer.attributionLog.length - 1];
  assert.equal(rec.id, 'voided');
  assert.equal(rec.reason, 'host-void-touch');
  assert.equal(rec.tierBefore, 2);
  assert.equal(rec.tierAfter, 1);
  // Voiding a decoy the identity never touched is a no-op.
  const noop = layer.voidTouch('voided', 'D99');
  assert.equal(noop.voided, 0);
  assert.equal(noop.voidedDelta, 0);
});

test('5A exhaustion: fleet budget exhaustion falls back to observe-only', () => {
  const layer = enabledLayer({ alphaCap: 2, alphaWindowDays: 30 });
  const a = layer.c27Flag('alpha-a', { epoch: 1, novel90: 420, ageDays: 90 });
  const b = layer.c27Flag('alpha-b', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(a.tier, 1);
  assert.equal(b.tier, 1);
  // The fleet budget (2 tier-ups) is spent: a third identity's flag is
  // recorded as evidence but grants NO tier - observe-only fallback.
  const c = layer.c27Flag('alpha-c', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(c.tier, 0);
  assert.equal(c.reason, 'alpha-wealth exhausted: observe-only fallback');
  assert.ok(c.d27 > 0, 'evidence still accrues while the gate is exhausted');
  const fleet = layer.snapshot();
  assert.equal(fleet.alpha.spent, 2);
  assert.equal(fleet.alpha.remaining, 0);
  assert.equal(fleet.alpha.exhausted, true);
  // Existing tiers are untouched by the fallback.
  assert.equal(layer.snapshot('alpha-a').tier, 1);
  // The window refills: after alphaWindowDays, tier-ups resume.
  layer.advanceDays(30);
  assert.equal(layer.snapshot().alpha.exhausted, false);
  const d = layer.c27Flag('alpha-d', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(d.tier, 1);
});

test('default observe: a constructed layer enforces nothing until enabled', () => {
  const layer = createTier2Conversion({ alphaCap: 1000 });
  const r = layer.c27Flag('dormant', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(r.tier, 0);
  assert.equal(r.reason, 'conversion disabled: observe only');
  const t = layer.c35Touch('dormant', { decoy: 'D1' });
  assert.equal(t.tier, 0);
  assert.equal(t.taint, false);
  layer.setEnabled(true);
  const r2 = layer.c27Flag('dormant', { epoch: 2, novel90: 420, ageDays: 90, cohortUnion: 150 });
  assert.equal(r2.tier, 2);
});

test('protected identities never tier from inferred evidence (host-declared strata)', () => {
  const layer = enabledLayer({
    identityStrata: { reviewer: 'protected' },
    protectedIdentities: ['auditor'],
    classifyStratum: (id) => (id.startsWith('team-') ? 'review_team' : undefined),
  });
  for (const id of ['reviewer', 'auditor']) {
    const r1 = layer.c27Flag(id, { epoch: 1, novel90: 420, ageDays: 90 });
    const r2 = layer.c27Flag(id, { epoch: 2, novel90: 420, ageDays: 90, cohortUnion: 500 });
    assert.equal(r1.tier, 0);
    assert.equal(r2.tier, 0);
    assert.equal(r2.reason, 'protected: inferred evidence never tiers');
    assert.equal(layer.snapshot(id).protected, true);
  }
  // Undeclared identities use the pooled parameters and tier normally;
  // a declared non-protected stratum is carried in the snapshot.
  const pooled = driveToTier2(layer, 'walk-in');
  assert.equal(pooled.tier, 2);
  assert.equal(layer.snapshot('walk-in').stratum, null);
  layer.c27Flag('team-7', { epoch: 1, novel90: 420, ageDays: 90 });
  assert.equal(layer.snapshot('team-7').stratum, 'review_team');
  assert.equal(layer.snapshot('team-7').tier, 1);
});

test('C27 gates: LAUNCH age and scale floor hold a flag at telemetry', () => {
  const layer = enabledLayer();
  const young = layer.c27Flag('young', { epoch: 1, novel90: 900, ageDays: 59 });
  assert.equal(young.telemetryOnly, true);
  assert.equal(young.tier, 0);
  const small = layer.c27Flag('small', { epoch: 1, novel90: 149, ageDays: 90 });
  assert.equal(small.telemetryOnly, true);
  assert.equal(small.tier, 0);
});

test('grace and cooldown: a pass suppresses step-up, two clean windows cool to tier 0', () => {
  const layer = enabledLayer();
  layer.c27Flag('gracey', { epoch: 1, novel90: 420, ageDays: 90 });
  layer.passStepUp('gracey');
  const during = layer.c27Flag('gracey', { epoch: 2, novel90: 420, ageDays: 90 });
  assert.equal(during.tier, 0);
  assert.equal(during.reason, 'grace suppresses step-up');
  const cool = enabledLayer();
  cool.c27Flag('cooling', { epoch: 1, novel90: 420, ageDays: 90 });
  cool.c27CleanWindow('cooling');
  const done = cool.c27CleanWindow('cooling');
  assert.equal(done.tier, 0);
});

test('tier 2 expires after 30 days without a new flag; kill switch zeroes every tier', () => {
  const layer = enabledLayer();
  driveToTier2(layer, 'expiring');
  layer.advanceDays(31);
  assert.equal(layer.snapshot('expiring').tier, 0);
  const layer2 = enabledLayer();
  driveToTier2(layer2, 'switched');
  const ups = layer2.telemetry.tierUp;
  layer2.setEnabled(false);
  assert.equal(layer2.snapshot('switched').tier, 0);
  assert.equal(layer2.telemetry.tierUp, ups, 'kill switch keeps telemetry');
});

test('invalid inputs throw the named error', () => {
  const layer = enabledLayer();
  assert.throws(() => layer.c27Flag('', { epoch: 1 }), Tier2ConversionError);
  assert.throws(() => layer.c35Touch('x', {}), Tier2ConversionError);
  assert.throws(() => createTier2Conversion({ alphaCap: 0 }), Tier2ConversionError);
  assert.equal(FLOOR, 500);
});
