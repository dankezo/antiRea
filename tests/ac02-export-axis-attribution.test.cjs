const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-02 (PASS-LAB, ac-batch2-lab): served axis exact on fresh
// sessions (distinct 20 / 120 / 60 at quotas 20 / 120 / 60); all 15
// captures attributable; zero leakage; 429-export attributable-with-0.

const tokens = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => `TK${String(from + i).padStart(3, '0')}`);

// Serve list pages of 20 up to the quota, exactly the lab shape.
function serveSession(attributor, identity, quota) {
  let served = 0;
  for (let page = 0; page < 6 && served < quota; page++) {
    const ids = tokens(page * 20 + 1, Math.min((page + 1) * 20, quota));
    attributor.recordServe(identity, 'list', ids);
    served += ids.length;
  }
  return served;
}

test('AC-02: served axis is exact on fresh sessions (distinct 20 / 120 / 60)', () => {
  const attributor = sdk.createExportAxisAttributor();
  assert.equal(serveSession(attributor, 's-q20', 20), 20);
  assert.equal(serveSession(attributor, 's-q120', 120), 120);
  assert.equal(serveSession(attributor, 's-q60', 60), 60);
  assert.equal(attributor.distinctServed('s-q20'), 20);
  assert.equal(attributor.distinctServed('s-q120'), 120);
  assert.equal(attributor.distinctServed('s-q60'), 60);
  assert.equal(attributor.distinctServed('s-q120', 'list'), 120);
  assert.equal(attributor.distinctServed('s-q120', 'export'), 0);
});

test('AC-02: all 15 captures are attributable to their serving axis with zero leakage', () => {
  const attributor = sdk.createExportAxisAttributor();
  const quotas = { 's-q20': 20, 's-q120': 120, 's-q60': 60 };
  for (const [sid, quota] of Object.entries(quotas)) serveSession(attributor, sid, quota);
  // 5 captures per session (index, p1, p3, p6, export), as in the lab:
  // a capture holds exactly the tokens of the page it shot, or none.
  let captures = 0;
  for (const [sid, quota] of Object.entries(quotas)) {
    const shots = [
      [],
      tokens(1, 20),
      quota >= 60 ? tokens(41, 60) : [],
      quota >= 120 ? tokens(101, 120) : [],
      quota >= 120 ? tokens(1, 120) : [],
    ];
    for (const shot of shots) {
      const result = attributor.attributeCapture(sid, shot, 'export');
      captures++;
      assert.equal(result.attributable, true, `${sid} capture of ${shot.length}`);
      assert.equal(result.leakedRecords, 0);
      assert.equal(result.matchedRecords, shot.length);
      if (shot.length > 0) assert.equal(result.axis, 'list');
    }
  }
  assert.equal(captures, 15);
});

test('AC-02: a capture holding a token the server never served leaks and does not attribute', () => {
  const attributor = sdk.createExportAxisAttributor();
  serveSession(attributor, 's1', 20);
  const result = attributor.attributeCapture('s1', [...tokens(1, 20), 'TK999']);
  assert.equal(result.attributable, false);
  assert.equal(result.leakedRecords, 1);
  assert.equal(result.matchedRecords, 20);
  // A token served to a DIFFERENT session is leakage here too.
  const cross = attributor.attributeCapture('s1', tokens(21, 40));
  assert.equal(cross.attributable, false);
  assert.equal(cross.leakedRecords, 20);
});

test('AC-02: a 429 export capture is attributable-with-0', () => {
  const attributor = sdk.createExportAxisAttributor();
  serveSession(attributor, 's1', 20);
  const result = attributor.attributeCapture('s1', [], 'export');
  assert.equal(result.attributable, true);
  assert.equal(result.attributableWithZero, true);
  assert.equal(result.matchedRecords, 0);
  assert.equal(result.axis, 'export');
});

test('AC-02: guard attribution is opt-in and names the export axis with served / 0 counts', async () => {
  const req = url => ({ url, method: 'GET', headers: { get: () => null } });
  const plain = sdk.createExportGuard({ maxRowsPerExport: 200, estimateRows: () => 30 });
  const plainResult = await plain.checkRequest(req('https://x.test/export'));
  assert.equal(plainResult.attribution, undefined);

  const guard = sdk.createExportGuard({ maxRowsPerExport: 200, estimateRows: () => 30, attribution: true });
  const allowed = await guard.checkRequest(req('https://x.test/export'));
  assert.equal(allowed.allowed, true);
  assert.deepEqual(allowed.attribution, {
    axis: 'export',
    servedDistinct: 30,
    attributable: true,
    attributableWithZero: false,
  });

  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  budget.charge('account:u1', 10);
  const capped = sdk.createExportGuard({
    maxRowsPerExport: 200,
    estimateRows: () => 30,
    attribution: true,
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'u1' }),
  });
  const rejected = await capped.checkRequest(req('https://x.test/export'));
  assert.equal(rejected.status, 429);
  assert.deepEqual(rejected.attribution, {
    axis: 'export',
    servedDistinct: 0,
    attributable: true,
    attributableWithZero: true,
  });
});
