const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const mockReq = (fields = {}) => ({
  url: 'https://example.test/api/accounts?page=1',
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

test('consume counts DISTINCT ids only; repeats inside the window are free', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  const first = budget.consume('account:a', ['r1', 'r2', 'r3']);
  assert.equal(first.used, 3);
  assert.equal(first.newlyCounted, 3);
  const second = budget.consume('account:a', ['r2', 'r3', 'r4']);
  assert.equal(second.used, 4);
  assert.equal(second.newlyCounted, 1);
  assert.equal(second.remaining, 6);
  assert.equal(second.exceeded, false);
});

test('check gates at the cap: an identity at budget may receive nothing more', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 3 });
  budget.consume('account:a', ['r1', 'r2']);
  assert.equal(budget.check('account:a', 1).allowed, true);
  assert.equal(budget.check('account:a', 2).allowed, false);
  budget.consume('account:a', ['r3']);
  const at = budget.check('account:a', 1);
  assert.equal(at.allowed, false);
  assert.equal(at.used, 3);
  assert.equal(at.remaining, 0);
});

test('window expiry resets usage (injected clock)', () => {
  let now = 1_000_000;
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 2, windowMs: 60_000, now: () => now });
  budget.consume('account:a', ['r1', 'r2']);
  assert.equal(budget.check('account:a', 1).allowed, false);
  now += 60_000;
  const after = budget.usage('account:a');
  assert.equal(after.used, 0);
  assert.equal(budget.check('account:a', 1).allowed, true);
});

test('setOverride only tightens, and expires with the window', () => {
  let now = 5_000_000;
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100, windowMs: 60_000, now: () => now });
  budget.setOverride('account:a', 10);
  assert.equal(budget.usage('account:a').limit, 10);
  budget.setOverride('account:a', 500); // an override can never raise the configured cap
  assert.equal(budget.usage('account:a').limit, 100);
  budget.setOverride('account:a', 10);
  budget.clearOverride('account:a');
  assert.equal(budget.usage('account:a').limit, 100);
  budget.setOverride('account:a', 10);
  now += 60_000; // window reset drops the override with the usage
  assert.equal(budget.usage('account:a').limit, 100);
});

test('charge burns budget units without ids and onExceeded fires once on crossing', () => {
  const events = [];
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10, onExceeded: e => events.push(e) });
  budget.charge('account:a', 6);
  assert.equal(events.length, 0);
  const crossed = budget.charge('account:a', 6);
  assert.equal(crossed.used, 12);
  assert.equal(crossed.exceeded, true);
  assert.equal(events.length, 1);
  assert.equal(events[0].identity, 'account:a');
  assert.equal(events[0].limit, 10);
  budget.charge('account:a', 5); // already over: no second event
  assert.equal(events.length, 1);
});

test('reset clears one identity or all identities', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  budget.consume('account:a', ['r1']);
  budget.consume('account:b', ['r2']);
  budget.reset('account:a');
  assert.equal(budget.usage('account:a').used, 0);
  assert.equal(budget.usage('account:b').used, 1);
  budget.reset();
  assert.equal(budget.usage('account:b').used, 0);
});

test('identity keys follow quota-guard precedence: account > apiKey > ip', async () => {
  const both = await sdk.resolveRecordBudgetIdentityKey(mockReq({ ip: '203.0.113.9' }), {
    resolveIdentity: () => ({ accountId: 'acc-1', apiKeyId: 'key-1' }),
  });
  assert.equal(both, 'account:acc-1');
  const keyOnly = await sdk.resolveRecordBudgetIdentityKey(mockReq({ ip: '203.0.113.9' }), {
    resolveIdentity: () => ({ apiKeyId: 'key-1' }),
  });
  assert.equal(keyOnly, 'apikey:key-1');
  const ipOnly = await sdk.resolveRecordBudgetIdentityKey(mockReq({ remoteAddress: '203.0.113.9' }), {});
  assert.equal(ipOnly, 'ip:203.0.113.9');
  const none = await sdk.resolveRecordBudgetIdentityKey(mockReq(), {});
  assert.equal(none, undefined);
});

test('middleware rejects an at-cap identity with 429 record_budget_exceeded and never runs the handler', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 2 });
  budget.consume('account:full', ['r1', 'r2']);
  const middleware = sdk.createExpressRecordBudgetMiddleware({
    budget,
    resolveIdentity: () => ({ accountId: 'full' }),
    extractRecordIds: body => body.items.map(item => item.id),
  });
  const res = mockRes();
  let nextCalled = false;
  await middleware(mockReq(), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'record_budget_exceeded');
  assert.equal(res.body.used, 2);
  assert.equal(res.body.limit, 2);
});

test('middleware consumes the ids a response actually contained, page by page, until the cap bites', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 5 });
  const middleware = sdk.createExpressRecordBudgetMiddleware({
    budget,
    resolveIdentity: () => ({ accountId: 'agent' }),
    extractRecordIds: body => body.items.map(item => item.id),
  });
  const runPage = async ids => {
    const res = mockRes();
    let ran = false;
    await middleware(mockReq(), res, () => {
      ran = true;
      res.status(200).json({ items: ids.map(id => ({ id })) });
    });
    return { ran, res };
  };
  assert.equal((await runPage(['a', 'b'])).ran, true);   // used 2
  assert.equal((await runPage(['c', 'd'])).ran, true);   // used 4
  const third = await runPage(['e', 'f']);                // gate passes at 4, response recorded: used 6
  assert.equal(third.ran, true);
  assert.equal(budget.usage('account:agent').used, 6);
  const fourth = await runPage(['g', 'h']);               // now at/over cap: rejected before the handler
  assert.equal(fourth.ran, false);
  assert.equal(fourth.res.statusCode, 429);
  assert.equal(fourth.res.body.error, 'record_budget_exceeded');
});

test('middleware passes requests with no resolvable identity through unbudgeted', async () => {
  const middleware = sdk.createExpressRecordBudgetMiddleware({
    maxDistinctPerWindow: 1,
    extractRecordIds: () => ['r1'],
  });
  const res = mockRes();
  let nextCalled = false;
  await middleware(mockReq(), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, undefined);
});

test('consumeExported prices by state: viewed ids cost 1 more, unseen cost 2, re-export is free', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 1_000 });
  const ids25 = Array.from({ length: 25 }, (_, i) => `r${i}`);
  budget.consume('account:a', ids25); // view: 25 x state 1
  assert.equal(budget.usage('account:a').used, 25);
  const upgrade = budget.consumeExported('account:a', ids25); // 1 -> 2: the export step costs 25, not the flat 50
  assert.equal(upgrade.newlyCounted, 0);
  assert.equal(budget.usage('account:a').used, 50);
  const reexport = budget.consumeExported('account:a', ids25); // 2 -> 2: free
  assert.equal(reexport.newlyCounted, 0);
  assert.equal(budget.usage('account:a').used, 50);
  const fresh = budget.consumeExported('account:b', ids25); // unseen -> 2: 2 each
  assert.equal(fresh.newlyCounted, 25);
  assert.equal(budget.usage('account:b').used, 50);
  // A later VIEW of an exported record is also free (state stays 2).
  budget.consume('account:b', ids25);
  assert.equal(budget.usage('account:b').used, 50);
});

test('reserve holds units against check and other reserves until release', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  assert.equal(budget.reserve('account:a', 6), true);
  assert.equal(budget.reserve('account:a', 5), false); // 6 + 5 > 10
  assert.equal(budget.check('account:a', 4).allowed, true); // 6 reserved + 4 = 10
  assert.equal(budget.check('account:a', 5).allowed, false);
  budget.release('account:a', 6);
  assert.equal(budget.reserve('account:a', 5), true);
  budget.release('account:a', 99); // over-release clamps at zero
  assert.equal(budget.check('account:a', 10).allowed, true);
  budget.consume('account:a', ['r1', 'r2']);
  assert.equal(budget.reserve('account:a', 9), false); // consumed usage counts too
  assert.equal(budget.reserve('account:a', 8), true);
});

test('middleware reserveUnits rejects a second in-flight request at the boundary, then admits it after settle', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  const middleware = sdk.createExpressRecordBudgetMiddleware({
    budget,
    reserveUnits: 6,
    resolveIdentity: () => ({ accountId: 'burst' }),
    extractRecordIds: body => body.items.map(item => item.id),
  });
  // Request 1: passes the gate, reserves 6, handler defers its response.
  const res1 = mockRes();
  let respond1;
  const p1 = middleware(mockReq(), res1, () => {
    respond1 = () => res1.status(200).json({ items: [{ id: 'a' }, { id: 'b' }] });
  });
  await p1;
  assert.equal(typeof respond1, 'function');
  // Request 2 while request 1 is in flight: 0 used + 6 reserved + 6 > 10.
  const res2 = mockRes();
  let ran2 = false;
  await middleware(mockReq(), res2, () => { ran2 = true; });
  assert.equal(ran2, false);
  assert.equal(res2.statusCode, 429);
  assert.equal(res2.body.error, 'record_budget_exceeded');
  // Request 1 settles: consumes 2 ids, releases its 6 reserved units.
  respond1();
  assert.equal(budget.usage('account:burst').used, 2);
  // Request 2 retried now fits: 2 used + 6 reserved <= 10.
  const res3 = mockRes();
  let ran3 = false;
  await middleware(mockReq(), res3, () => {
    ran3 = true;
    res3.status(200).json({ items: [{ id: 'c' }] });
  });
  assert.equal(ran3, true);
  assert.equal(budget.usage('account:burst').used, 3);
});

test('ip identities live in a partitioned pool: 5000 ip entries never evict account state', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 10 });
  budget.consume('account:vip', ['r1', 'r2', 'r3']);
  for (let i = 0; i < 5_000; i++) {
    budget.consume(`ip:203.0.${Math.floor(i / 250)}.${i % 250}`, ['x']);
  }
  const vip = budget.usage('account:vip');
  assert.equal(vip.used, 3);
  assert.deepEqual(budget.consume('account:vip', ['r1', 'r2', 'r3']).newlyCounted, 0);
});

test('record ids are stored as bounded hashes: a 64KB id dedupes and stays one unit', () => {
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

test('an entry stops STORING new record keys past limit + 1024 but still reports exceeded', () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 5 }); // storage cap: 5 + 1024 = 1029 keys
  const ids = Array.from({ length: 1_500 }, (_, i) => `row-${i}`);
  const bulk = budget.consume('account:a', ids);
  assert.equal(bulk.exceeded, true);
  assert.ok(bulk.used >= 1_500, 'every served record still counts toward used');
  // An early id WAS stored: re-consuming it is free.
  assert.equal(budget.consume('account:a', ['row-0']).newlyCounted, 0);
  // A late id was beyond the storage cap: not retained, so it counts again.
  assert.equal(budget.consume('account:a', ['row-1499']).newlyCounted, 1);
});

test('middleware charges the empty-result floor for zero-id responses (no free oracles)', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const middleware = sdk.createExpressRecordBudgetMiddleware({
    budget,
    resolveIdentity: () => ({ accountId: 'prober' }),
    extractRecordIds: body => body.items ?? [],
  });
  const runEmpty = async () => {
    const res = mockRes();
    await middleware(mockReq(), res, () => { res.status(200).json({ items: [] }); });
    return res;
  };
  await runEmpty();
  assert.equal(budget.usage('account:prober').used, 1); // default floor: 1
  await runEmpty();
  assert.equal(budget.usage('account:prober').used, 2);
});

test('middleware sets Cache-Control: private, no-store unless noStore is false', async () => {
  const build = extra => sdk.createExpressRecordBudgetMiddleware({
    maxDistinctPerWindow: 100,
    resolveIdentity: () => ({ accountId: 'u1' }),
    extractRecordIds: body => body.items.map(item => item.id),
    ...extra,
  });
  const res1 = mockRes();
  await build({})(mockReq(), res1, () => { res1.status(200).json({ items: [{ id: 'r1' }] }); });
  assert.equal(res1.headers['cache-control'], 'private, no-store');
  const res2 = mockRes();
  await build({ noStore: false })(mockReq(), res2, () => { res2.status(200).json({ items: [{ id: 'r1' }] }); });
  assert.equal(res2.headers['cache-control'], undefined);
});

test('a throwing extractRecordIds never breaks the host response', async () => {
  const middleware = sdk.createExpressRecordBudgetMiddleware({
    maxDistinctPerWindow: 10,
    resolveIdentity: () => ({ accountId: 'u1' }),
    extractRecordIds: () => { throw new Error('host bug'); },
  });
  const res = mockRes();
  await middleware(mockReq(), res, () => { res.status(200).json({ ok: true }); });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});
