const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/*
 * Port regression tests for the 2.7.0 tree (audit
 * ~/workspace/self-learning/audits/antirea-270-pre-release-2026-11-03/).
 *
 * The F-02 / F-03 / F-04 tests are extracted VERBATIM from the 2.6.3
 * tree's tests/audit-wave2.test.cjs (same scenarios, same assertions -
 * nothing loosened); they encode the retest bars of FIX-REPORT-WAVE2.md
 * sections 1-3. The CLK tests are the record-budget / quota-guard
 * scenarios from the 2.6.3 tree's tests/mono-clock.test.cjs
 * (L-DEEP-2 harness scenarios 1-3). The F-14 and F-15 tests are NEW:
 * both findings were still open in 2.6.3, so there was nothing to port.
 *
 *   F-02 quota peek->record race on shared stores (port from 2.6.3)
 *   F-03 export per-record path: no pre-flight reservation (port)
 *   F-04 export CSV / streamed bodies priced at 0 (port)
 *   CLK  wall-clock steps must not move interval windows (port)
 *   F-14 export guard silently skips the budget when no identity
 *        resolves (NEW fix: shared `unknown:unresolved` bucket)
 *   F-15 record-budget hash cost grows linearly with id length
 *        (NEW fix: bounded head/tail sample + full length)
 */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

/* -------------------- CLK (L-DEEP-2, ported scenarios) -------------------- */

const makeClocks = (start = 1_700_000_000_000) => {
  let wall = start;
  let mono = start;
  return {
    now: () => wall,
    monoNow: () => mono,
    advanceReal(ms) {
      wall += ms;
      mono += ms;
    },
    stepWall(ms) {
      wall += ms;
    },
  };
};

const ids = (prefix, n, from = 0) => Array.from({ length: n }, (_, i) => `${prefix}${from + i}`);

test('record budget: a +5 min wall step does not reset the window (harness scenario 1)', () => {
  const clocks = makeClocks();
  const budget = sdk.createRecordBudget({
    maxDistinctPerWindow: 100,
    windowMs: 60_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const first = budget.consume('account:extractor', ids('r', 100));
  assert.equal(first.used, 100);
  assert.equal(budget.check('account:extractor', 1).allowed, false);

  clocks.advanceReal(10_000);
  clocks.stepWall(300_000); // wall jumps +5 min; only 10 real seconds passed

  // Pre-patch, the wall step expired the window and batch 2 sailed
  // through uncapped. On the monotonic clock the window is intact.
  assert.equal(budget.check('account:extractor', 1).allowed, false);
  const second = budget.consume('account:extractor', ids('s', 100));
  assert.equal(second.exceeded, true);
  assert.equal(second.used, 200); // counted in the SAME window
});

test('record budget: a -5 min wall step does not stretch the window (harness scenario 2)', () => {
  const clocks = makeClocks();
  const budget = sdk.createRecordBudget({
    maxDistinctPerWindow: 100,
    windowMs: 60_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  budget.consume('account:legit', ids('r', 100));
  assert.equal(budget.check('account:legit', 1).allowed, false);

  clocks.stepWall(-300_000); // wall jumps back 5 min
  clocks.advanceReal(60_000); // the window's real 60 s have now elapsed

  // Pre-patch, the identity stayed blocked until real second 360.
  // On the monotonic clock the window resets on schedule.
  const usage = budget.usage('account:legit');
  assert.equal(usage.used, 0);
  assert.equal(usage.remaining, 100);
  assert.equal(budget.check('account:legit', 100).allowed, true);
});

test('quota guard: a +5 min wall step does not reopen the sliding window', async () => {
  const clocks = makeClocks();
  const guard = sdk.createQuotaGuard({ now: clocks.now, monoNow: clocks.monoNow });
  const req = () => ({
    url: 'https://example.test/api/accounts?page=1',
    method: 'GET',
    headers: { get: () => null },
    ip: '203.0.113.7',
  });
  // Anonymous tier: 30 requests per 60 s.
  for (let i = 0; i < 30; i++) {
    const result = await guard.checkRequest(req());
    assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
  }
  clocks.advanceReal(1_000);
  clocks.stepWall(300_000);

  // Pre-patch, the step pruned the first burst out of the window and
  // this request was admitted. On the monotonic clock it is refused.
  const blocked = await guard.checkRequest(req());
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.body.error, 'rate_limit_exceeded');
});

/* ------------------------------ F-14 (NEW) ------------------------------ */

const UNKNOWN_KEY = 'unknown:unresolved';
const noIdentity = () => ({});

test('F-14: an export with no resolvable identity is bucketed as unknown, not exempt (audit h3 H1-8)', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: noIdentity,
    extractRecordIds: body => body.rows.map(r => r.id),
  });
  const req = { url: 'https://example.test/api/reports/export', method: 'GET', headers: { get: () => null } };
  const r = await guard.checkRequest(req);
  // Pre-fix this returned { allowed: true } with identityKey undefined
  // and every budget effect skipped - a silent fail-open.
  assert.equal(r.allowed, true);
  assert.equal(r.identityKey, UNKNOWN_KEY);
});

test('F-14: flat pricing lands on the unknown bucket and its cap is enforced', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 8 });
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: noIdentity,
    estimateRows: () => 3, // flat cost: 3 rows x multiplier 2 = 6
  });
  const first = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(first.allowed, true);
  assert.equal(first.identityKey, UNKNOWN_KEY);
  assert.equal(budget.usage(UNKNOWN_KEY).used, 6, 'identity-less exports share - and pay into - one bucket');

  const second = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(second.allowed, false, 'the shared bucket cap binds identity-less exports too');
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'record_budget_exceeded');
  assert.equal(budget.usage(UNKNOWN_KEY).used, 6, 'a refused export charges nothing');
});

test('F-14: 422 rejections charge the rejection floor to the unknown bucket', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: noIdentity,
    estimateRows: () => 10_000,
  });
  const result = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'export_scope_too_broad');
  assert.equal(budget.usage(UNKNOWN_KEY).used, 1, 'probing the guard is not free even without an identity');
});

test('F-14: the per-record gate and middleware pricing apply to the unknown bucket', async () => {
  // Gate: an unknown bucket already at its cap refuses the export.
  const capped = sdk.createRecordBudget({ maxDistinctPerWindow: 8 });
  capped.charge(UNKNOWN_KEY, 8);
  const gateGuard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: capped,
    resolveIdentity: noIdentity,
    extractRecordIds: body => body.rows.map(r => r.id),
  });
  const refused = await gateGuard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(refused.allowed, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'record_budget_exceeded');

  // Middleware: a JSON export with no resolvable identity is priced
  // per-record against the unknown bucket, exactly like a named one.
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const middleware = exportMiddleware(budget, { resolveIdentity: noIdentity, estimateRows: () => 3 });
  const res = mockRes();
  let ran = false;
  await middleware(mockReq('https://example.test/api/reports/export'), res, () => {
    ran = true;
    res.status(200).json({ rows: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] });
  });
  assert.equal(ran, true);
  assert.equal(budget.usage(UNKNOWN_KEY).used, 6);

  // And a CSV export (flat-priced under F-04) lands on the same bucket.
  const budgetCsv = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const mwCsv = exportMiddleware(budgetCsv, { resolveIdentity: noIdentity, estimateRows: () => 3 });
  const resCsv = mockRes();
  await mwCsv(mockReq('https://example.test/api/reports/export'), resCsv, () => {
    resCsv.end('id\nx1\nx2\nx3\n');
  });
  assert.equal(budgetCsv.usage(UNKNOWN_KEY).used, 6);
});

test('F-14: allowUnresolvedIdentity restores the legacy skip, explicitly', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 8 });
  budget.charge(UNKNOWN_KEY, 8); // even with the unknown bucket full...
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: noIdentity,
    estimateRows: () => 3,
    allowUnresolvedIdentity: true,
  });
  const result = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(result.allowed, true, 'the opt-in keeps the pre-fix pass-through');
  assert.equal(result.identityKey, undefined);
  assert.equal(budget.usage(UNKNOWN_KEY).used, 8, 'nothing extra was charged');
});

/* ------------------------------ F-15 (NEW) ------------------------------ */

test('F-15: hashing a 2,000,000-char id is cost-bounded and still dedupes (audit h6 timing scenario)', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const longId = 'x'.repeat(2_000_000);
  const t0 = process.hrtime.bigint();
  const first = budget.consume('account:a', [longId]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.equal(first.newlyCounted, 1);
  assert.equal(first.used, 1);
  // Pre-fix this single consume measured ~158-221 ms (one BigInt step
  // per char). The sampled hash is ~1k steps regardless of id length;
  // the 100 ms bar leaves wide headroom for slow CI while still
  // failing the pre-fix implementation.
  assert.ok(ms < 100, `consume of one 2M-char id took ${ms.toFixed(1)}ms`);
  const again = budget.consume('account:a', [longId]);
  assert.equal(again.newlyCounted, 0, 'the same long id still dedupes exactly');
  assert.equal(again.used, 1);
});

test('F-15: long ids are distinguished by sampled head, sampled tail and full length', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const base = 'a'.repeat(2_000);
  assert.equal(budget.consume('account:a', [base]).newlyCounted, 1);
  // Differs at char 0 - inside the head sample.
  assert.equal(budget.consume('account:a', ['b' + 'a'.repeat(1_999)]).newlyCounted, 1);
  // Differs at the last char - inside the tail sample.
  assert.equal(budget.consume('account:a', ['a'.repeat(1_999) + 'b']).newlyCounted, 1);
  // Head and tail samples identical to base ('a' x 512 each) - only the
  // full length differs, and that alone must keep the keys apart.
  assert.equal(budget.consume('account:a', ['a'.repeat(3_000)]).newlyCounted, 1);
  assert.equal(budget.usage('account:a').used, 4);
  // Re-consuming any of them is free (each id's key is stable).
  assert.equal(budget.consume('account:a', [base]).newlyCounted, 0);
  assert.equal(budget.consume('account:a', ['a'.repeat(3_000)]).newlyCounted, 0);
});

test('F-15: 64KB ids keep the established dedupe/distinction behavior on the sampled path', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  const huge = 'x'.repeat(65_536);
  const first = budget.consume('account:a', [huge]);
  assert.equal(first.used, 1);
  assert.equal(first.newlyCounted, 1);
  const again = budget.consume('account:a', [huge]);
  assert.equal(again.newlyCounted, 0);
  assert.equal(again.used, 1);
  const other = budget.consume('account:a', ['y'.repeat(65_536)]);
  assert.equal(other.newlyCounted, 1);
  assert.equal(other.used, 2);
});

test('F-15: ids at or below the full-hash length keep exact pre-fix semantics', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  const atLimit = 'k'.repeat(1_024); // boundary: hashed in full
  assert.equal(budget.consume('account:a', [atLimit]).newlyCounted, 1);
  assert.equal(budget.consume('account:a', [atLimit]).newlyCounted, 0);
  assert.equal(budget.consume('account:a', ['k'.repeat(1_023) + 'j']).newlyCounted, 1);
  assert.equal(budget.consume('account:a', ['r1', 'r2']).newlyCounted, 2);
  assert.equal(budget.consume('account:a', ['r1']).newlyCounted, 0);
});
