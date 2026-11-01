const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const mockReq = (url, fields = {}) => ({
  url,
  method: 'GET',
  headers: { get: () => null },
  ...fields,
});

const mockRes = () => ({
  headers: {},
  statusCode: undefined,
  body: undefined,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end(body) { if (body !== undefined) this.body = body; },
});

test('an export estimated above the row cap is rejected 422 export_scope_too_broad (the 1-call dump)', async () => {
  const guard = sdk.createExportGuard({ maxRowsPerExport: 25, estimateRows: () => 10_000 });
  const result = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(result.allowed, false);
  assert.equal(result.status, 422);
  assert.equal(result.body.error, 'export_scope_too_broad');
  assert.equal(result.body.maxRowsPerExport, 25);
  assert.equal(result.body.estimatedRows, 10_000);
});

test('requireFilterParams rejects unfiltered exports and accepts narrowed ones', async () => {
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    requireFilterParams: ['region', 'segment'],
    estimateRows: () => 10,
  });
  const unfiltered = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(unfiltered.allowed, false);
  assert.equal(unfiltered.status, 422);
  assert.equal(unfiltered.body.error, 'export_filter_required');
  const narrowed = await guard.checkRequest(mockReq('https://example.test/api/reports/export?region=eu'));
  assert.equal(narrowed.allowed, true);
});

test('the antireaExportRows request property is the fallback estimate', async () => {
  const guard = sdk.createExportGuard({ maxRowsPerExport: 25 });
  const result = await guard.checkRequest(
    mockReq('https://example.test/api/reports/export', { antireaExportRows: 500 }),
  );
  assert.equal(result.allowed, false);
  assert.equal(result.body.error, 'export_scope_too_broad');
});

test('an allowed export charges the record budget at the multiplier (default 2x)', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    estimateRows: () => 10,
  });
  const result = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(result.allowed, true);
  assert.equal(budget.usage('account:u1').used, 20);
});

test('an export the budget cannot afford is rejected 429 record_budget_exceeded', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 15 });
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    estimateRows: () => 10, // 10 rows x 2 = 20 > 15
  });
  const result = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(result.allowed, false);
  assert.equal(result.status, 429);
  assert.equal(result.body.error, 'record_budget_exceeded');
  assert.equal(result.body.limit, 15);
  assert.equal(budget.usage('account:u1').used, 0); // nothing was charged
});

test('with no row estimate the scope cap cannot judge, but the filter floor still applies', async () => {
  const guard = sdk.createExportGuard({ maxRowsPerExport: 25, requireFilterParams: ['region'] });
  const noEstimate = await guard.checkRequest(mockReq('https://example.test/api/reports/export?region=eu'));
  assert.equal(noEstimate.allowed, true);
  assert.equal(noEstimate.estimatedRows, undefined);
  const noFilter = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(noFilter.allowed, false);
  assert.equal(noFilter.body.error, 'export_filter_required');
});

test('per-record pricing: exporting already-viewed ids costs the state delta, never the flat multiplier', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const ids25 = Array.from({ length: 25 }, (_, i) => `r${i}`);
  budget.consume('account:u1', ids25); // the user viewed all 25 first
  assert.equal(budget.usage('account:u1').used, 25);

  const middleware = sdk.createExpressExportGuardMiddleware({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    estimateRows: () => 25,
    extractRecordIds: body => body.rows.map(row => row.id),
  });
  const runExport = async ids => {
    const res = mockRes();
    let ran = false;
    await middleware(mockReq('https://example.test/api/reports/export'), res, () => {
      ran = true;
      res.status(200).json({ rows: ids.map(id => ({ id })) });
    });
    return ran;
  };
  assert.equal(await runExport(ids25), true);
  // 25 viewed (25) + export upgrade 1->2 (25) = 50 total. The flat path
  // would have charged 25 + 25x2 = 75 for the same records.
  assert.equal(budget.usage('account:u1').used, 50);
  // Re-exporting the same ids is free.
  assert.equal(await runExport(ids25), true);
  assert.equal(budget.usage('account:u1').used, 50);
});

test('per-record pricing: exporting unseen ids costs 2 each through the middleware', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const middleware = sdk.createExpressExportGuardMiddleware({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u2' }),
    estimateRows: () => 3,
    extractRecordIds: body => body.rows.map(row => row.id),
  });
  const res = mockRes();
  await middleware(mockReq('https://example.test/api/reports/export'), res, () => {
    res.status(200).json({ rows: [{ id: 'x1' }, { id: 'x2' }, { id: 'x3' }] });
  });
  assert.equal(budget.usage('account:u2').used, 6);
});

test('422 rejections charge the rejection floor when a budget is attached (no free guard oracle)', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const guard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    estimateRows: () => 10_000,
  });
  const result = await guard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(result.status, 422);
  assert.equal(budget.usage('account:u1').used, 1); // default floor: 1

  const filterGuard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    requireFilterParams: ['region'],
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    estimateRows: () => 5,
  });
  const filtered = await filterGuard.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(filtered.body.error, 'export_filter_required');
  assert.equal(budget.usage('account:u1').used, 2); // floor charged again

  const noFloor = sdk.createExportGuard({
    maxRowsPerExport: 25,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
    estimateRows: () => 10_000,
    rejectionFloorUnits: 0,
  });
  await noFloor.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(budget.usage('account:u1').used, 2); // floor disabled: unchanged
});

test('guard responses carry Cache-Control: private, no-store unless noStore is false', async () => {
  const middleware = sdk.createExpressExportGuardMiddleware({
    maxRowsPerExport: 25,
    estimateRows: () => 500,
  });
  const res = mockRes();
  await middleware(mockReq('https://example.test/api/reports/export'), res, () => {});
  assert.equal(res.statusCode, 422);
  assert.equal(res.headers['cache-control'], 'private, no-store');

  const open = sdk.createExportGuard({ maxRowsPerExport: 25, estimateRows: () => 5, noStore: false });
  const allowed = await open.checkRequest(mockReq('https://example.test/api/reports/export'));
  assert.equal(allowed.headers['Cache-Control'], undefined);
});

test('middleware responds with the rejection or passes allowed exports through', async () => {
  const middleware = sdk.createExpressExportGuardMiddleware({
    maxRowsPerExport: 25,
    estimateRows: req => (req.url.includes('big') ? 500 : 5),
  });
  const bigRes = mockRes();
  let bigNext = false;
  await middleware(mockReq('https://example.test/api/reports/export?kind=big'), bigRes, () => { bigNext = true; });
  assert.equal(bigNext, false);
  assert.equal(bigRes.statusCode, 422);
  assert.equal(bigRes.body.error, 'export_scope_too_broad');

  const okReq = mockReq('https://example.test/api/reports/export?kind=small');
  const okRes = mockRes();
  let okNext = false;
  await middleware(okReq, okRes, () => { okNext = true; });
  assert.equal(okNext, true);
  assert.equal(okReq.exportEstimate, 5);
});
