const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * Declared campaign ceiling ARMING (2.5.0 ceiling fix).
 *
 * The pre-fix classic cell (v) of the 2.5.0 round failed its registered exact-600 line:
 * the lawful hard ceiling engaged only at a CUSUM crossing, and by
 * the time each declared cohort crossed, its union was already ~900
 * against the declared 600 (2,700 total). These tests pin the fix:
 *
 * - host-declared cohort + ceiling-tier manifest: the ceiling is
 *   ARMED at declaration - the cohort exists from construction, the
 *   union counts from the first record, and checkServe refuses at
 *   the limit with no crossing and no consequence floor;
 * - host-declared cohort WITHOUT a ceiling-tier manifest: nothing is
 *   armed and the armed path locks nothing;
 * - inferred cohorts: the crossing-gated path is byte-for-byte the
 *   old behaviour (no arming, ever);
 * - the protected-cohort registry is a separate concept: a protected
 *   subject inside an INFERRED cohort still passes checkServe whole,
 *   even when that cohort's ceiling engaged at its crossing.
 */

const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });
const NOW = 1_000_000;

const CEILING_MANIFEST = {
  modelVersion: 'cusum-1',
  calibrationVersion: 'host-fit-1',
  sampleSizes: { legit: 500, attack: 120 },
  holdout: { falsePositiveRate: 0.001, falseNegativeRate: 0.2 },
  method: 'trace-fitted LLR tables, LOAFO',
  attestedBy: 'host security team',
  issuedAtMs: 900_000,
  expiresAtMs: 9_000_000,
};

/** Same manifest shape, but the FP rate only reaches the step_down tier. */
const STEP_DOWN_MANIFEST = {
  ...CEILING_MANIFEST,
  holdout: { falsePositiveRate: 0.2, falseNegativeRate: 0.2 },
};

const DECLARED = [['account:a', 'account:b', 'account:c', 'account:d']];

/** Serve records with NO evidence-bearing shape (no predicate, no
 * detail, no cursor): the CUSUM score cannot move, so nothing in
 * these feeds can cross - any refusal afterwards is the armed cap,
 * not a crossing consequence. */
async function feedPlain(tw, identity, from, count, ts) {
  return tw.observe({ type: 'page_view', identity, recordIds: ids(from, count), ts });
}

async function feedSlicers(tw, names, ts = 1_000_000) {
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

test('declared ceiling ARMED: declared + ceiling-tier manifest arms at declaration and stops exactly at the limit before any crossing', async () => {
  const flags = [];
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    declaredCohorts: DECLARED,
    manifest: CEILING_MANIFEST,
    now: () => NOW,
    onCampaignFlag: snap => flags.push(snap),
  });

  // Armed from declaration: the cohort exists before any event, the
  // snapshot says so, and nothing has flagged.
  const atDeclaration = await tw.snapshotFor('account:a');
  assert.ok(atDeclaration, 'a declared cohort exists from construction');
  assert.deepEqual(atDeclaration.members, ['account:a', 'account:b', 'account:c', 'account:d']);
  assert.equal(atDeclaration.ceilingArmed, true);
  assert.equal(atDeclaration.ceilingActive, true);
  assert.equal(atDeclaration.flagged, false);
  assert.equal(atDeclaration.unionRecords, 0);
  assert.equal(atDeclaration.ceilingLimit, 50);

  // Below the cap, an armed cohort serves whole: no pacing tax, the
  // cap is the only armed consequence.
  assert.deepEqual(await tw.checkServe('account:a', 10), { allowed: 10 });

  // The union counts from the first record, across all members.
  await feedPlain(tw, 'account:a', 0, 20, NOW);
  const second = await feedPlain(tw, 'account:b', 100, 20, NOW + 100);
  assert.equal(second.ceilingActive, true);
  assert.equal(second.flagged, false);
  assert.deepEqual(await tw.checkServe('account:c', 5), { allowed: 5 });

  // Land the union EXACTLY on the limit (40 + 10 = 50).
  const atCap = await feedPlain(tw, 'account:c', 200, 10, NOW + 200);
  assert.equal(atCap.flagged, false, 'no crossing was involved');
  assert.equal(atCap.action, 'campaign_engaged', 'the decision reports the armed engagement at the cap');

  // From here checkServe refuses every member, before any crossing.
  const refused = await tw.checkServe('account:d', 1);
  assert.equal(refused.allowed, 0);
  assert.equal(refused.reason, 'campaign_ceiling');
  assert.equal(refused.cohortId, atDeclaration.cohortId);
  assert.equal((await tw.checkServe('account:a', 1)).allowed, 0);

  const atRefusal = await tw.snapshotFor('account:a');
  assert.equal(atRefusal.unionRecords, 50, 'the union stopped exactly at the declared limit');
  assert.equal(atRefusal.flagged, false, 'the flag never fired - the cap did not need it');
  assert.equal(atRefusal.ceilingActive, true);
  assert.equal(flags.length, 0, 'onCampaignFlag never fired: no crossing, no flag, still capped');

  // Identities outside the declared cohort are untouched.
  assert.deepEqual(await tw.checkServe('account:outsider', 7), { allowed: 7 });
});

test('declared ceiling ARMED: a multi-record request is capped at the remaining headroom - no request-granularity overshoot', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    declaredCohorts: DECLARED,
    manifest: CEILING_MANIFEST,
    now: () => NOW,
  });
  await feedPlain(tw, 'account:a', 0, 20, NOW);
  await feedPlain(tw, 'account:b', 100, 20, NOW + 100);
  await feedPlain(tw, 'account:c', 200, 8, NOW + 200);
  // Union 48, headroom 2: a 10-record request is allowed exactly 2,
  // so a host serving `allowed` lands the union exactly on 50.
  const capped = await tw.checkServe('account:d', 10);
  assert.equal(capped.allowed, 2);
  assert.equal(capped.reason, 'campaign_ceiling');
  await feedPlain(tw, 'account:d', 300, 2, NOW + 300);
  assert.equal((await tw.snapshotFor('account:a')).unionRecords, 50);
  assert.equal((await tw.checkServe('account:d', 1)).allowed, 0);
});

test('declared ceiling ARMED: a single-member declared group is capped and its snapshot reports the armed state', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 5 },
    declaredCohorts: [['account:solo']],
    manifest: CEILING_MANIFEST,
    now: () => NOW,
  });
  const decision = await feedPlain(tw, 'account:solo', 0, 5, NOW);
  assert.equal(decision.ceilingActive, true, 'the decision reports the armed ceiling even without a pair');
  const snapshot = await tw.snapshotFor('account:solo');
  assert.ok(snapshot, 'an armed single-member cohort has a snapshot');
  assert.equal(snapshot.ceilingArmed, true);
  assert.equal(snapshot.unionRecords, 5);
  const refused = await tw.checkServe('account:solo', 1);
  assert.equal(refused.allowed, 0);
  assert.equal(refused.reason, 'campaign_ceiling');
});

test('declared ceiling NOT ARMED: a declared cohort without a ceiling-tier manifest gets no armed hard lock', async () => {
  for (const manifest of [null, STEP_DOWN_MANIFEST]) {
    const tw = sdk.createCusumTripwire({
      mode: 'enforce',
      alpha: 0.05,
      ceiling: { limit: 50 },
      declaredCohorts: DECLARED,
      manifest,
      now: () => NOW,
    });
    const atDeclaration = await tw.snapshotFor('account:a');
    assert.ok(atDeclaration, 'the declared cohort still forms - origin is a fact');
    assert.equal(atDeclaration.ceilingArmed, false, `manifest tier ${manifest ? 'step_down' : 'none'} arms nothing`);
    assert.equal(atDeclaration.ceilingActive, false);

    // Push the union past the limit with evidence-free serves: the
    // armed path must not lock (a crossing under the tiering law is
    // a separate path and is not exercised here).
    await feedPlain(tw, 'account:a', 0, 20, NOW);
    await feedPlain(tw, 'account:b', 100, 20, NOW + 100);
    await feedPlain(tw, 'account:c', 200, 15, NOW + 200);
    const snapshot = await tw.snapshotFor('account:a');
    assert.equal(snapshot.unionRecords, 55);
    assert.equal(snapshot.flagged, false);
    assert.equal(snapshot.ceilingActive, false);
    assert.deepEqual(await tw.checkServe('account:a', 1), { allowed: 1 });
  }
});

test('declared ceiling ARMED but observe mode restricts nothing', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'observe',
    alpha: 0.05,
    ceiling: { limit: 50 },
    declaredCohorts: DECLARED,
    manifest: CEILING_MANIFEST,
    now: () => NOW,
  });
  await feedPlain(tw, 'account:a', 0, 30, NOW);
  await feedPlain(tw, 'account:b', 100, 30, NOW + 100);
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.ceilingArmed, true, 'the armed state reflects the declaration + manifest');
  assert.equal(snapshot.unionRecords, 60);
  assert.deepEqual(await tw.checkServe('account:a', 5), { allowed: 5 }, 'observe mode is a pass-through');
});

test('inferred cohorts are NEVER armed: the crossing-gated path is unchanged', async () => {
  // (a) No manifest: an eligible inferred crossing still caps at step_up.
  const twPlain = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, now: () => NOW });
  const plainDecisions = await feedSlicers(twPlain, ['a', 'b', 'c', 'd']);
  assert.equal(plainDecisions[plainDecisions.length - 1].action, 'step_up');
  const plainSnapshot = await twPlain.snapshotFor('account:a');
  assert.equal(plainSnapshot.ceilingArmed, false);
  assert.equal(plainSnapshot.ceilingActive, false);

  // (b) Ceiling-tier manifest: an inferred cohort is NOT locked
  // before its crossing even with the union past the ceiling limit,
  // and engages exactly as before once it crosses.
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    manifest: CEILING_MANIFEST,
    now: () => NOW,
  });
  await feedPlain(tw, 'account:a', 0, 20, NOW);
  await feedPlain(tw, 'account:b', 100, 20, NOW + 100);
  await feedPlain(tw, 'account:c', 200, 15, NOW + 200);
  assert.equal(await tw.snapshotFor('account:a'), null, 'no cohort has formed - nothing to lock');
  assert.deepEqual(await tw.checkServe('account:a', 1), { allowed: 1 }, 'union 55 > limit 50, but inferred means crossing-gated');

  const decisions = await feedSlicers(tw, ['a', 'b', 'c', 'd'], NOW + 1000);
  const last = decisions[decisions.length - 1];
  assert.equal(last.crossed, true);
  assert.equal(last.action, 'campaign_engaged', 'the old crossing path still engages the ceiling');
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.ceilingArmed, false, 'engaged at a crossing is not armed at declaration');
  assert.equal(snapshot.ceilingActive, true);
  const refused = await tw.checkServe('account:b', 1);
  assert.equal(refused.allowed, 0);
  assert.equal(refused.reason, 'campaign_ceiling');
});

test('protected registry stays separate: a protected subject in an inferred cohort passes checkServe even when that cohort ceiling engaged', async () => {
  const registry = sdk.createProtectedCohortRegistry();
  registry.declareProtected(['account:comp1'], { reason: 'quarterly compliance review' });
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    ceiling: { limit: 50 },
    manifest: CEILING_MANIFEST,
    declaredCohorts: [['account:x', 'account:y']],
    isProtected: id => registry.isProtected(id),
    now: () => NOW,
  });

  // The declared group arms on its own track...
  const declaredSnapshot = await tw.snapshotFor('account:x');
  assert.equal(declaredSnapshot.ceilingArmed, true);

  // ...while the compliance-shaped inferred cohort (comp1 + 3 seats,
  // none of them declared) forms and crosses exactly as before.
  const decisions = await feedSlicers(tw, ['comp1', 'b', 'c', 'd']);
  assert.equal(decisions[decisions.length - 1].action, 'campaign_engaged');
  const snapshot = await tw.snapshotFor('account:comp1');
  assert.equal(snapshot.ceilingArmed, false);
  assert.equal(snapshot.ceilingActive, true);
  assert.deepEqual(snapshot.protectedMembers, ['account:comp1']);

  // Protection is per-subject and survives the engagement: comp1
  // passes whole, an unprotected member of the same cohort is capped.
  assert.deepEqual(await tw.checkServe('account:comp1', 10), { allowed: 10 });
  const refused = await tw.checkServe('account:b', 1);
  assert.equal(refused.allowed, 0);
  assert.equal(refused.reason, 'campaign_ceiling');
});
