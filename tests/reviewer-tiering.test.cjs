const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/* --------------------------- tiering law ------------------------------- */

test('tiering: inferred cohorts cap at observe ungated, and at the friction tier (soft budget step-down) when a tripwire gated', () => {
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'audit_only' }),
    'observe',
  );
  // 09:44 law: the friction tier - step_up plus a SOFT budget
  // step-down - is the default cap for a gated inferred cohort.
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true }),
    'budget_step_down',
  );
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'step_down', tripwireGated: true }),
    'budget_step_down',
  );
});

test('tiering: inferred cohorts reach hard_ceiling ONLY on ceiling-tier calibrated evidence', () => {
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'inferred', calibrationTier: 'ceiling', tripwireGated: true }),
    'hard_ceiling',
  );
  // Deny is never available on inference, whatever the calibration.
  const clamp = sdk.clampEnforcement('deny', { origin: 'inferred', calibrationTier: 'ceiling', tripwireGated: true });
  assert.equal(clamp.action, 'hard_ceiling');
  assert.equal(clamp.clamped, true);
});

test('tiering: an inferred cohort can never be hard-cut through the clamp (the R5 rule, 09:44 revision)', () => {
  const clamp = sdk.clampEnforcement('hard_ceiling', {
    origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true,
  });
  // Hard ceiling clamps to the friction tier's top: a SOFT step-down.
  assert.equal(clamp.action, 'budget_step_down');
  assert.equal(clamp.clamped, true);
  assert.match(clamp.reason, /inferred cohorts are capped/);
  assert.equal(clamp.budgetFloorRecords, sdk.SOFT_BUDGET_FLOOR_RECORDS);
  // A soft step-down is now lawful by default - but it is floored:
  // even a demand to cut to zero lands at the 500-record floor.
  const stepDown = sdk.clampEnforcement('budget_step_down', {
    origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true,
  });
  assert.equal(stepDown.action, 'budget_step_down');
  assert.equal(stepDown.clamped, false);
  assert.equal(stepDown.budgetFloorRecords, 500);
  const toZero = sdk.softBudgetStepDown(2000, 0, {
    origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true,
  });
  assert.equal(toZero.limit, 500);
  assert.equal(toZero.floored, true);
  const denied = sdk.clampEnforcement('deny', {
    origin: 'inferred', calibrationTier: 'audit_only', tripwireGated: true,
  });
  assert.equal(denied.action, 'budget_step_down');
  assert.equal(denied.clamped, true);
});

test('tiering: host-declared cohorts may be hard-ceilinged; deny needs ceiling-tier calibration', () => {
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'host_declared', calibrationTier: 'audit_only' }),
    'hard_ceiling',
  );
  assert.equal(
    sdk.maxEnforcementAction({ origin: 'host_declared', calibrationTier: 'ceiling' }),
    'deny',
  );
  const clamp = sdk.clampEnforcement('deny', { origin: 'host_declared', calibrationTier: 'step_down' });
  assert.equal(clamp.action, 'hard_ceiling');
  assert.equal(clamp.clamped, true);
});

test('tiering: the herd graduated_only band carries zero price and rejects priced configs', () => {
  assert.equal(sdk.herdBandPrice('graduated_only'), 0);
  assert.equal(sdk.herdBandPrice('budget_cut_supported'), 0);
  // The exact R5 wiring mistake: an override hung on the graduated band.
  const priced = sdk.validateHerdResponseConfig({ band: 'graduated_only', budgetOverride: 500 });
  assert.equal(priced.valid, false);
  assert.match(priced.errors.join(' '), /budget override/);
  const multiplied = sdk.validateHerdResponseConfig({ band: 'graduated_only', coldFetchMultiplier: 5 });
  assert.equal(multiplied.valid, false);
  const perRecord = sdk.validateHerdResponseConfig({ band: 'graduated_only', pricePerRecord: 5 });
  assert.equal(perRecord.valid, false);
  // Clean configs pass, including a cut-band override routed via the ladder.
  assert.equal(sdk.validateHerdResponseConfig({ band: 'graduated_only' }).valid, true);
  assert.equal(sdk.validateHerdResponseConfig({ band: 'budget_cut_supported', budgetOverride: 100 }).valid, true);
});

/* ------------------------- evidence reviewer --------------------------- */

const BUNDLE = {
  cohortId: 'coh:account:a',
  score: 7.4,
  flagged: true,
  unionRecords: 812,
  memberCount: 6,
  streamIncrements: { adjacency: 1.4, tiling: 0, cold: 0.95, velocity: 0.45 },
  calibrationVersion: 'r6-calib-1',
  uncalibrated: true,
  generatedAtMs: 1_000_000,
};

test('reviewer: bundle builder bounds the stream summary and carries no record data', () => {
  const bundle = sdk.buildEvidenceBundle({
    cohortId: 'coh:x', score: 1, flagged: false, unionRecords: 3, memberCount: 2,
    streamIncrements: { a: 1, b: 2, c: 3, d: 4 },
    calibrationVersion: 'r6-calib-1', uncalibrated: true,
  }, { maxStreamEntries: 2, now: 5 });
  assert.deepEqual(Object.keys(bundle.streamIncrements), ['a', 'b']);
  assert.equal(bundle.generatedAtMs, 5);
  assert.equal('recordIds' in bundle, false);
});

test('reviewer: schema validation accepts only the fixed advisory vocabulary', () => {
  const good = sdk.validateReviewerProposal({ action: 'request_human_review', confidence: 0.8, rationale: 'tiling looks coordinated' });
  assert.equal(good.valid, true);
  for (const bad of [
    { action: 'deny', confidence: 0.9, rationale: 'block them' },
    { action: 'set_budget', confidence: 0.9, rationale: 'cut to zero' },
    { action: 'request_step_up', confidence: 0.9, rationale: 'ok', budgetOverride: 0 },
    { action: 'request_step_up', confidence: 1.5, rationale: 'ok' },
    { action: 'request_step_up', confidence: 0.5, rationale: 'x'.repeat(501) },
    'request_step_up',
    null,
  ]) {
    assert.equal(sdk.validateReviewerProposal(bad).valid, false, JSON.stringify(bad));
  }
});

test('reviewer: validated proposals reach the host callback; enforcement-shaped output is rejected', async () => {
  const delivered = [];
  const rejected = [];
  const channel = sdk.createReviewerChannel({
    reviewer: { review: () => ({ action: 'request_step_up', confidence: 0.7, rationale: 'ambiguous band' }) },
    onProposal: proposal => delivered.push(proposal),
    onRejected: (raw, errors) => rejected.push(errors),
  });
  const result = await channel.invoke(BUNDLE);
  assert.equal(result.delivered, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].action, 'request_step_up');

  const hostile = sdk.createReviewerChannel({
    reviewer: { review: () => ({ action: 'deny', confidence: 1, rationale: 'definitely bots' }) },
    onProposal: proposal => delivered.push(proposal),
    onRejected: (raw, errors) => rejected.push(errors),
  });
  const blocked = await hostile.invoke(BUNDLE);
  assert.equal(blocked.delivered, false);
  assert.equal(delivered.length, 1, 'the hostile proposal must not reach the host as a proposal');
  assert.equal(rejected.length, 1);
});

test('reviewer ONE-WAY: reviewer output cannot move the evidence stream it was derived from', async () => {
  const tw = sdk.createCusumTripwire({ alpha: 0.05 });
  await tw.observe({ type: 'list', identity: 'account:a', predicate: { field: 'id', min: 0, max: 1000, domainMin: 0, domainMax: 10_000 }, ts: 1_000_000 });
  const before = await tw.observe({ type: 'list', identity: 'account:b', predicate: { field: 'id', min: 1005, max: 2000, domainMin: 0, domainMax: 10_000 }, ts: 1_000_100 });
  const snapshotBefore = await tw.snapshotFor('account:a');

  const channel = sdk.createReviewerChannel({
    reviewer: {
      review: () => ({ action: 'request_human_review', confidence: 0.99, rationale: 'says the cohort is guilty' }),
    },
    onProposal: () => {},
  });
  // The channel surface is exactly one method - there is no write path.
  assert.deepEqual(Object.keys(channel), ['invoke']);
  const bundle = sdk.buildEvidenceBundle({
    cohortId: snapshotBefore.cohortId,
    score: snapshotBefore.score,
    flagged: snapshotBefore.flagged,
    unionRecords: snapshotBefore.unionRecords,
    memberCount: snapshotBefore.members.length,
    streamIncrements: before.increments,
    calibrationVersion: snapshotBefore.calibrationVersion,
    uncalibrated: snapshotBefore.uncalibrated,
  });
  const invoked = await channel.invoke(bundle);
  assert.equal(invoked.delivered, true);

  const snapshotAfter = await tw.snapshotFor('account:a');
  assert.equal(snapshotAfter.score, snapshotBefore.score, 'reviewer output must not feed the LLR stream (double-counting)');
  assert.equal(snapshotAfter.flagged, snapshotBefore.flagged);
});
