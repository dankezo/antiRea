const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/*
 * Wave-2 audit regression tests (audit of 2.6.0, REPORT.md in
 * ~/workspace/self-learning/audits/antirea-260-full-2026-11-02/).
 * Each test encodes the finding's attack scenario and the REPORT's
 * retest bar; every one of them fails against the pre-patch build
 * (verified by running this file against the pre-patch dist - see
 * FIX-REPORT-WAVE2.md for the discrimination record).
 *
 *   F-02 quota peek->record race on shared stores
 *   F-03 export per-record path: no pre-flight reservation
 *   F-04 export CSV / streamed bodies priced at 0
 *   F-05 action-budget: an unpriced action is free forever
 *   F-08 cusum host callbacks unwrapped (throwing onCampaignFlag)
 *   F-09 checkServe(NaN) permanently poisons the cohort bucket
 *   F-10 cusum identity state grows unboundedly
 *   F-11 cusum score/contributions never reset at epoch rotation
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ids = (from, count) => Array.from({ length: count }, (_, i) => from + i);

/* ------------------------------ F-02 ------------------------------ */

const quotaReq = () => ({ url: 'http://api.test/items', headers: { get: () => null } });

function quotaGuardWith(store) {
  return sdk.createQuotaGuard({
    store,
    tiers: { t: { maxRequests: 5, windowMs: 60_000, maxPageSize: 50, maxPage: 10 } },
    defaultTier: 't',
    resolveIdentity: () => ({ accountId: 'acct', tier: 't' }),
  });
}

/** Delayed store whose recordIfBelow is atomic once entered (delay sits
 *  outside the operation, like a real Redis Lua / SQL backend). */
function delayedAtomicStore() {
  const inner = sdk.createInMemoryQuotaStore();
  return {
    peek: async (k, n, w) => { await sleep(15); return inner.peek(k, n, w); },
    record: async (k, n, w) => { await sleep(15); return inner.record(k, n, w); },
    recordIfBelow: async (k, n, w, limit) => { await sleep(15); return inner.recordIfBelow(k, n, w, limit); },
  };
}

function delayedLegacyStore() {
  const inner = sdk.createInMemoryQuotaStore();
  return {
    peek: async (k, n, w) => { await sleep(15); return inner.peek(k, n, w); },
    record: async (k, n, w) => { await sleep(15); return inner.record(k, n, w); },
  };
}

test('F-02: atomic store - 12 parallel requests against a limit of 5 admit exactly 5', async () => {
  const guard = quotaGuardWith(delayedAtomicStore());
  assert.equal(guard.atomicEnforcement, true);
  const results = await Promise.all(Array.from({ length: 12 }, () => guard.checkRequest(quotaReq())));
  const allowed = results.filter(r => r.allowed);
  assert.equal(allowed.length, 5, 'retest bar: exactly the tier limit is admitted');
  for (const r of results) assert.equal(r.atomicEnforcement, true);
  // Each admitted request saw a distinct post-record count: the
  // remaining headroom steps 4,3,2,1,0 with no duplicates - proof the
  // check and the record were one indivisible step per request.
  const remaining = allowed.map(r => Number(r.headers['X-RateLimit-Remaining'])).sort((a, b) => a - b);
  assert.deepEqual(remaining, [0, 1, 2, 3, 4]);
  const refused = results.filter(r => !r.allowed);
  assert.equal(refused.length, 7);
  for (const r of refused) assert.equal(r.body.error, 'rate_limit_exceeded');
});

test('F-02: legacy peek/record store keeps the race - and is flagged non-atomic, never hidden', async () => {
  const guard = quotaGuardWith(delayedLegacyStore());
  assert.equal(guard.atomicEnforcement, false);
  const results = await Promise.all(Array.from({ length: 12 }, () => guard.checkRequest(quotaReq())));
  for (const r of results) assert.equal(r.atomicEnforcement, false);
  // The pre-fix behavior (12/12 through a limit of 5) is what a legacy
  // store still gets - the difference after the fix is that the guard
  // SAYS so on every result instead of implying a hard guarantee.
  assert.equal(results.filter(r => r.allowed).length, 12);
});

test('F-02: the bundled default store is atomic; capacity and malformed atomic outcomes fail closed', async () => {
  assert.equal(sdk.createQuotaGuard({}).atomicEnforcement, true);

  const capacity = quotaGuardWith({
    peek: () => ({ count: 0 }),
    record: () => true,
    recordIfBelow: () => ({ recorded: false, refusal: 'capacity', count: 0 }),
  });
  const capResult = await capacity.checkRequest(quotaReq());
  assert.equal(capResult.allowed, false);
  assert.equal(capResult.body.error, 'store_capacity_exceeded');

  const malformed = quotaGuardWith({
    peek: () => ({ count: 0 }),
    record: () => true,
    recordIfBelow: () => ({ nope: 1 }),
  });
  const badResult = await malformed.checkRequest(quotaReq());
  assert.equal(badResult.allowed, false);
  assert.equal(badResult.body.error, 'store_unavailable');

  const throwing = quotaGuardWith({
    peek: () => ({ count: 0 }),
    record: () => true,
    recordIfBelow: () => { throw new Error('backend down'); },
  });
  const throwResult = await throwing.checkRequest(quotaReq());
  assert.equal(throwResult.allowed, false);
  assert.equal(throwResult.body.error, 'store_unavailable');
});

/* --------------------------- F-03 + F-04 --------------------------- */

const mockReq = (url, fields = {}) => ({ url, method: 'GET', headers: { get: () => null }, ...fields });

const mockRes = () => ({
  headers: {},
  statusCode: undefined,
  body: undefined,
  chunks: [],
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  write(chunk) { this.chunks.push(String(chunk)); return true; },
  send(body) { this.end(body); },
  end(body) { if (body !== undefined) this.body = body; },
});

const rowsExtractor = body => (body && Array.isArray(body.rows) ? body.rows.map(row => row.id) : []);

function exportMiddleware(budget, overrides = {}) {
  return sdk.createExpressExportGuardMiddleware({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    extractRecordIds: rowsExtractor,
    ...overrides,
  });
}

test('F-03: parallel exports cannot jointly overshoot the record cap (audit h7 scenario)', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 8 });
  const middleware = exportMiddleware(budget, { estimateRows: () => 3 });
  const batches = [0, 1, 2, 3].map(i => [`r${i * 3}`, `r${i * 3 + 1}`, `r${i * 3 + 2}`]);
  // Preflight all four exports BEFORE any handler runs - the audit's
  // interleaving. Handlers are captured, not executed.
  const pending = [];
  const responses = [];
  for (let i = 0; i < 4; i++) {
    const res = mockRes();
    responses.push(res);
    await middleware(mockReq('https://example.test/api/reports/export'), res, () => {
      pending.push(() => res.status(200).json({ rows: batches[i].map(id => ({ id })) }));
    });
  }
  assert.equal(pending.length, 1, 'only one export may be in flight against a cap of 8 (worst case 2 x 3 rows)');
  const rejected = responses.filter(r => r.statusCode === 429);
  assert.equal(rejected.length, 3);
  for (const r of rejected) assert.equal(r.body.error, 'record_budget_exceeded');
  // Run the admitted handler: 3 distinct records served, 6 units used.
  for (const run of pending) run();
  assert.equal(budget.usage('account:u1').used, 6);
  assert.equal(
    budget.check('account:u1', 2).allowed,
    true,
    'the reservation was released at settle (check counts reserved units: 6 used + 0 held + 2 <= 8)',
  );
  // And because it was released, a further small export still fits the
  // remaining headroom exactly (1 unseen record = 2 units -> 8 total).
  const res2 = mockRes();
  let ran2 = false;
  await exportMiddleware(budget, { estimateRows: () => 1 })(
    mockReq('https://example.test/api/reports/export'),
    res2,
    () => { ran2 = true; res2.status(200).json({ rows: [{ id: 'r100' }] }); },
  );
  assert.equal(ran2, true);
  assert.equal(budget.usage('account:u1').used, 8);
});

test('F-04: CSV and streamed export bodies are priced, not free (audit h4 matrix)', async () => {
  const csv = 'id\nx1\nx2\nx3\n';
  const cases = [
    ['json control', res => res.status(200).json({ rows: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] }), 6],
    ['CSV via end(string)', res => res.end(csv), 6],
    ['CSV via send(string)', res => res.send(csv), 6],
    ['CSV streamed via write + end', res => { res.write('id\nx1\n'); res.write('x2\nx3\n'); res.end(); }, 6],
    ['JSON string via end() still prices per-record', res => res.end(JSON.stringify({ rows: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] })), 6],
  ];
  for (const [name, handler, expected] of cases) {
    const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
    const middleware = exportMiddleware(budget, { estimateRows: () => 3 });
    const res = mockRes();
    let ran = false;
    await middleware(mockReq('https://example.test/api/reports/export'), res, () => { ran = true; handler(res); });
    assert.equal(ran, true, name);
    assert.equal(budget.usage('account:u1').used, expected, `${name}: body priced like the JSON path`);
  }
});

test('F-04: without an estimate a non-JSON body pays the floor; JSON per-record pricing needs no estimate', async () => {
  const budgetCsv = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const resCsv = mockRes();
  await exportMiddleware(budgetCsv)(mockReq('https://example.test/api/reports/export'), resCsv, () => {
    resCsv.end('id\nx1\nx2\nx3\n');
  });
  assert.equal(budgetCsv.usage('account:u1').used, 1, 'unpriced-body floor (default 1 unit)');

  const budgetJson = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const resJson = mockRes();
  await exportMiddleware(budgetJson)(mockReq('https://example.test/api/reports/export'), resJson, () => {
    resJson.status(200).json({ rows: [{ id: 'x1' }, { id: 'x2' }] });
  });
  assert.equal(budgetJson.usage('account:u1').used, 4, 'per-record pricing is unaffected by a missing estimate');
});

/* ------------------------------ F-05 ------------------------------ */

function actionBudgetWith(overrides = {}) {
  return sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10, freebie: 0 },
    bucket: { burst: 100_000, refillPerSecond: 100_000 },
    ...overrides,
  });
}

test('F-05: an unpriced action is refused unknown_action - 0 of 30 granted (audit V3 scenario)', async () => {
  const budget = actionBudgetWith();
  let granted = 0;
  for (let i = 0; i < 30; i++) {
    const r = await budget.reserveAction({ subject: 'account:a', action: 'teleport' });
    if (r.allowed) granted++;
    assert.equal(r.allowed, false);
    assert.equal(r.reason, 'unknown_action');
    assert.equal(r.cost, 0);
  }
  assert.equal(granted, 0, 'retest bar: no unpriced action is granted');
});

test('F-05: deliberate zeros and explicit costs still work; NaN cost is not a price', async () => {
  const budget = actionBudgetWith();
  const explicit = await budget.reserveAction({ subject: 'account:a', action: 'teleport', cost: 5 });
  assert.equal(explicit.allowed, true);
  assert.equal(explicit.cost, 5);
  assert.equal(explicit.unpriced, undefined);

  const explicitZero = await budget.reserveAction({ subject: 'account:b', action: 'teleport', cost: 0 });
  assert.equal(explicitZero.allowed, true, 'an explicit cost: 0 is the host\u2019s deliberate choice');
  assert.equal(explicitZero.cost, 0);

  const tableZero = await budget.reserveAction({ subject: 'account:c', action: 'freebie' });
  assert.equal(tableZero.allowed, true, 'a table entry priced at 0 is deliberate too');
  assert.equal(tableZero.cost, 0);
  assert.equal(tableZero.unpriced, undefined);

  const nanUnpriced = await budget.reserveAction({ subject: 'account:d', action: 'teleport', cost: NaN });
  assert.equal(nanUnpriced.allowed, false);
  assert.equal(nanUnpriced.reason, 'unknown_action', 'NaN falls through to the unpriced path, not to a silent 0');

  const nanPriced = await budget.reserveAction({ subject: 'account:e', action: 'export', cost: NaN });
  assert.equal(nanPriced.allowed, true);
  assert.equal(nanPriced.cost, 10, 'NaN explicit cost falls back to the table price');
});

test('F-05: unknownActionCost charges the fallback and flags the result unpriced', async () => {
  const budget = actionBudgetWith({ unknownActionCost: 7, subjectAllowance: 10 });
  const first = await budget.reserveAction({ subject: 'account:a', action: 'teleport' });
  assert.equal(first.allowed, true);
  assert.equal(first.cost, 7);
  assert.equal(first.unpriced, true);
  // The fallback cost is real accounting: a second reserve would take
  // reserved cost to 14 over an allowance of 10 and is refused.
  const second = await budget.reserveAction({ subject: 'account:a', action: 'teleport' });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'subject_budget_exceeded');
  assert.equal(second.unpriced, true);
  const committed = await budget.commitAction(first.reservationId);
  assert.equal(committed.committed, true);
});

/* --------------------- cusum helpers (F-08..F-11) --------------------- */

const PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

/** Four identities slicing abutting ranges (the suite's standard
 *  adjacency-driven crossing; union at crossing = 160 >= floor 150). */
async function feedSlicers(tw, ts = 1_000_000) {
  const decisions = [];
  decisions.push(await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:c', predicate: PRED(2010, 3000), recordIds: ids(2010, 40), ts }));
  decisions.push(await tw.observe({ type: 'list', identity: 'account:d', predicate: PRED(3010, 4000), recordIds: ids(3010, 40), ts }));
  return decisions;
}

/* ------------------------------ F-08 ------------------------------ */

test('F-08: a throwing onCampaignFlag neither rejects observe nor loses the flag', async () => {
  const delivered = [];
  let calls = 0;
  const tw = sdk.createCusumTripwire({
    mode: 'observe',
    alpha: 0.05,
    onCampaignFlag: snap => {
      calls++;
      if (calls === 1) throw new Error('host callback bug');
      delivered.push(snap);
    },
  });
  // Pre-fix, the crossing observe rejected with the host's error.
  const decisions = await feedSlicers(tw);
  assert.equal(decisions[decisions.length - 1].crossed, true);
  assert.equal(delivered.length, 0, 'the first delivery attempt threw');
  // The next observe of a cohort member retries and delivers.
  await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(5000, 3), ts: 1_000_100 });
  assert.equal(delivered.length, 1, 'retest bar: the flag IS delivered at the next observe');
  assert.equal(delivered[0].flagged, true);
  assert.ok(delivered[0].members.includes('account:a'));
});

test('F-08: a pending flag is also delivered by the next snapshot read', async () => {
  const delivered = [];
  let fail = true;
  const tw = sdk.createCusumTripwire({
    mode: 'observe',
    alpha: 0.05,
    onCampaignFlag: snap => {
      if (fail) throw new Error('host callback bug');
      delivered.push(snap);
    },
  });
  await feedSlicers(tw);
  assert.equal(delivered.length, 0);
  fail = false;
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.flagged, true);
  assert.equal(delivered.length, 1, 'snapshotFor retried the pending delivery');
});

test('F-08: throwing isProtected / isExempt predicates behave as absent predicates', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    isProtected: () => { throw new Error('host bug'); },
  });
  const decisions = await feedSlicers(tw);
  // Treated as "not protected": the crossing consequence is NOT
  // suppressed (pre-fix, observe/checkServe threw the host's error).
  assert.equal(decisions[decisions.length - 1].action, 'step_up');
  const snapshot = await tw.snapshotFor('account:a');
  assert.deepEqual(snapshot.protectedMembers, []);
  const serve = await tw.checkServe('account:a', 5);
  assert.equal(serve.allowed, 5);

  const tw2 = sdk.createCusumTripwire({
    alpha: 0.05,
    isExempt: () => { throw new Error('host bug'); },
  });
  const decisions2 = await feedSlicers(tw2);
  assert.equal(decisions2[decisions2.length - 1].crossed, true, 'a throwing isExempt does not exempt anyone');
});

/* ------------------------------ F-09 ------------------------------ */

test('F-09: checkServe(NaN) is refused and the cohort bucket stays healthy (audit H2-5 sequence)', async () => {
  const tw = sdk.createCusumTripwire({
    mode: 'enforce',
    alpha: 0.05,
    now: () => 1_000_000,
    monoNow: () => 7_000,
  });
  await feedSlicers(tw);
  const ok1 = await tw.checkServe('account:a', 10);
  assert.equal(ok1.allowed, 10);
  const poison = await tw.checkServe('account:a', NaN);
  assert.equal(poison.allowed, 0);
  assert.equal(poison.reason, 'invalid_request');
  assert.equal(typeof poison.cohortId, 'string');
  for (const bad of [-5, Infinity, -Infinity]) {
    const r = await tw.checkServe('account:a', bad);
    assert.equal(r.allowed, 0);
    assert.equal(r.reason, 'invalid_request');
  }
  // Retest bar: after ok -> NaN -> ok, the third request is healthy.
  const ok2 = await tw.checkServe('account:a', 10);
  assert.equal(ok2.allowed, 10, 'the bucket was not poisoned by the NaN call');
  const snapshot = await tw.snapshotFor('account:a');
  assert.equal(snapshot.bucketTokens, 130, 'exactly the two valid debits left the bucket (150 - 10 - 10)');
  // An invalid request from an identity with no cohort is refused too.
  const nobody = await tw.checkServe('account:nobody', NaN);
  assert.equal(nobody.allowed, 0);
  assert.equal(nobody.reason, 'invalid_request');
  assert.equal(nobody.cohortId, undefined);
  // clearCohort is a real recovery path now: it restores a full bucket.
  await tw.clearCohort(snapshot.cohortId);
  const cleared = await tw.snapshotFor('account:a');
  assert.equal(cleared.bucketTokens, 150, 'clearCohort resets the pacing bucket to burst');
});

/* ------------------------------ F-10 ------------------------------ */

test('F-10: identity state is capped; an active cohort survives churn (LRU)', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05, maxIdentities: 10 });
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts: 1_000_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts: 1_000_000 });
  let snapshot = await tw.snapshotFor('account:a');
  assert.ok(snapshot, 'the slicer pair formed a cohort');
  // Churn 30 singleton identities past the cap of 10, keeping the
  // cohort members active so LRU must retain them.
  for (let i = 0; i < 30; i++) {
    await tw.observe({ type: 'search', identity: `churn:${i}`, ts: 1_000_100 + i });
    if (i % 3 === 0) {
      await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(0, 1), ts: 1_000_100 + i });
      await tw.observe({ type: 'list', identity: 'account:b', recordIds: ids(1005, 1), ts: 1_000_100 + i });
    }
  }
  snapshot = await tw.snapshotFor('account:a');
  assert.ok(snapshot, 'retest bar: the ACTIVE cohort was not evicted');
  assert.deepEqual(snapshot.members, ['account:a', 'account:b']);
  assert.equal(snapshot.stateSizes.identities, 10, 'state size stays at the cap after 32 identities');
  assert.ok(snapshot.stateSizes.cohorts >= 1);
  assert.equal(typeof snapshot.stateSizes.pairThrottles, 'number');
});

test('F-10: evicting quiet cohort members (incl. the union-find root) leaves a working engine', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'observe', alpha: 0.05, maxIdentities: 10 });
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts: 1_000_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts: 1_000_000 });
  assert.ok(await tw.snapshotFor('account:a'));
  // Neither member acts again: churn pushes both out (one eviction
  // retires the union-find root and must promote/re-key cleanly).
  for (let i = 0; i < 15; i++) {
    await tw.observe({ type: 'search', identity: `churn:${i}`, ts: 1_000_100 + i });
  }
  assert.equal(await tw.snapshotFor('account:a'), null, 'both members evicted; no zombie cohort remains');
  // The engine still works afterwards: the pair can form again.
  await tw.observe({ type: 'list', identity: 'account:a', predicate: PRED(0, 1000), recordIds: ids(0, 40), ts: 1_001_000 });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: PRED(1005, 2000), recordIds: ids(1005, 40), ts: 1_001_000 });
  assert.ok(await tw.snapshotFor('account:a'), 'the cohort re-forms after eviction');
});

/* ------------------------------ F-11 ------------------------------ */

test('F-11: epoch rotation resets score and contributions - no instant re-cross, no stale targets', async () => {
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05 });
  const decisions = await feedSlicers(tw, 1_000_000);
  assert.equal(decisions[decisions.length - 1].crossed, true);
  const before = await tw.snapshotFor('account:a');
  assert.equal(before.flagged, true);
  assert.ok(before.contributingMembers.includes('account:b'), 'b contributed before rotation');
  assert.ok(before.score >= Math.log(1 / 0.05) - 1e-9, 'score at/above the boundary before rotation');
  // +90 days: the first event of the new epoch (the audit h6 control).
  const ts2 = 1_000_000 + 90 * 86_400_000;
  const first = await tw.observe({ type: 'list', identity: 'account:a', recordIds: ids(5000, 5), ts: ts2 });
  assert.equal(first.crossed, false, 'retest bar: the new epoch does not re-cross on stale score');
  assert.equal(first.flagged, false);
  assert.equal(first.score, 0, 'the accumulator restarted at the rotation');
  const after = await tw.snapshotFor('account:a');
  assert.equal(after.flagged, false);
  assert.ok(!after.contributingMembers.includes('account:b'), 'stale contributors are no longer targeted');
  assert.deepEqual(sdk.consequenceTargets(after).targets, [], 'no friction targets survive the rotation');
  assert.equal(after.unionRecords, 165, 'coverage is a fact: the union survives rotation (160 + 5 new)');
});
