const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * L-DEEP-2 regression tests: interval accounting runs on a monotonic
 * clock, so wall-clock steps (NTP corrections, VM suspend/resume) can
 * neither reset a window early nor stretch it past its design.
 *
 * The clock pair below models a step exactly: `advanceReal` moves
 * both clocks (real time passing); `stepWall` moves only the wall
 * clock (the step itself). The two record-budget scenarios are the
 * lab harness scenarios (l-deep-2-lab/harness.cjs) ported to the
 * shipped modules: a 60 s window with a ceiling of 100, measured
 * against the verbatim 2.6.1 dist copies in the lab, where the wall
 * arm served 200 records in 10 real seconds after a +5 min step and
 * blocked a legitimate identity for an extra 300 s after a -5 min
 * step.
 */
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

test('flow scorer: a -5 min wall step does not stretch the idle window', () => {
  const clocks = makeClocks();
  const scorer = sdk.createFlowScorer({
    windowMs: 10_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  scorer.observe('account:a', { routeClass: 'canary', status: 200 });
  assert.equal(scorer.score('account:a'), 50);

  clocks.stepWall(-300_000);
  clocks.advanceReal(11_000); // past the 10 s idle window in real time

  assert.equal(scorer.score('account:a'), 0);
});

test('herd detector: co-activity is measured on the monotonic clock', () => {
  const clocks = makeClocks();
  const detector = sdk.createHerdDetector({
    coActivityWindowMs: 60_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  for (const identity of ['account:a', 'account:b', 'account:c']) {
    detector.observe({ type: 'signup', identity, ip: '198.51.100.9' });
  }
  detector.observe({ type: 'list', identity: 'account:a', recordIds: ids('a', 50) });
  detector.observe({ type: 'list', identity: 'account:b', recordIds: ids('b', 50) });
  detector.observe({ type: 'list', identity: 'account:c', recordIds: ids('c', 50) });

  clocks.advanceReal(120_000); // 2 real minutes: outside the 60 s co-activity window
  clocks.stepWall(-300_000);
  detector.observe({ type: 'list', identity: 'account:a', recordIds: ['a50'] });

  const cohort = detector
    .groups()
    .find(group => group.mechanism === 'v1-cohort' && group.members.length === 3);
  assert.ok(cohort, 'expected the 3-member cohort group');
  // Only account:a was active inside the trailing real minute. Wall
  // arithmetic after the step would still count all three as active.
  assert.ok(Math.abs(cohort.features.coActivity - 1 / 3) < 1e-9);
});

test('action cohort: canary taints expire on the monotonic clock', () => {
  const clocks = makeClocks();
  const tracker = sdk.createActionCohortTracker({
    windowMs: 60_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
    isCanaryTarget: (action, targetKey) => targetKey === 'canary-slice',
  });
  tracker.observe({ subject: 'account:x', action: 'export', targetKey: 'canary-slice', cost: 1 });
  const live = tracker.taints();
  assert.equal(live.length, 1);
  // The public taint shape carries no monotonic bookkeeping.
  assert.deepEqual(Object.keys(live[0]).sort(), ['action', 'subject', 'targetKey', 'ts']);

  clocks.stepWall(-300_000);
  clocks.advanceReal(61_000); // past the 60 s taint window in real time

  assert.deepEqual(tracker.taints(), []);
});

test('disclosure ledger: a reservation created by this process dies at its monotonic TTL', async () => {
  const clocks = makeClocks();
  const ledger = sdk.createDisclosureLedger({
    store: sdk.createInMemoryTransactionalStore(),
    ceilingLimit: 1000,
    reservation: { ttlMs: 60_000 },
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const reserved = await ledger.reserveDisclosure({ subject: 'account:a', recordIds: [1, 2, 3] });
  assert.equal(reserved.allowed, true);

  clocks.stepWall(-300_000); // wall expiry (t0 + 60 s) is now 5 min in the wall future
  clocks.advanceReal(61_000); // but the TTL has fully elapsed in real time

  const swept = await ledger.sweepExpired();
  assert.equal(swept.expired, 1);
  const snapshot = await ledger.snapshot();
  assert.equal(snapshot.outstandingReservations, 0);
});

test('action budget: a subject window created by this process rolls on the monotonic clock', async () => {
  const clocks = makeClocks();
  const budget = sdk.createActionBudget({
    store: sdk.createInMemoryTransactionalStore(),
    prices: { export: 10 },
    subjectAllowance: 100,
    windowMs: 60_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const reserved = await budget.reserveAction({ subject: 'account:a', action: 'export' });
  assert.equal(reserved.allowed, true);
  const committed = await budget.commitAction(reserved.reservationId);
  assert.equal(committed.committed, true);
  let snapshot = await budget.snapshot();
  assert.equal(snapshot.subjects['account:a'].committedCost, 10);

  clocks.stepWall(-300_000);
  clocks.advanceReal(61_000); // the 60 s window has elapsed in real time

  // Wall-only accounting would keep the committed cost until real
  // second 360; the anchored window rolls on schedule.
  snapshot = await budget.snapshot();
  assert.equal(snapshot.subjects['account:a'].committedCost, 0);
});

/* ------------------------------------------------------------------ */
/* Dedicated tests for the five L-DEEP-2 points the scenarios above   */
/* do not reach: cusum bucket refill, the canary maze per-IP window,  */
/* evidence-attribution decay, the transport replay guard's TTL       */
/* purge, and the client behavior shield's performance.now windows.   */
/* ------------------------------------------------------------------ */

const numIds = (from, count) => Array.from({ length: count }, (_, i) => from + i);
const RANGE_PRED = (min, max) => ({ field: 'id', min, max, domainMin: 0, domainMax: 10_000 });

/**
 * The slicing shape from tests/cusum-tripwire.test.cjs (4 identities,
 * exact union 160 - above the 150 consequence floor), but observed
 * WITHOUT event timestamps so the events stamp the injected twin
 * clocks and the cohort bucket anchors on the monotonic one.
 */
const feedSlicersLive = async (tw) => {
  await tw.observe({ type: 'list', identity: 'account:a', predicate: RANGE_PRED(0, 1000), recordIds: numIds(0, 40) });
  await tw.observe({ type: 'list', identity: 'account:b', predicate: RANGE_PRED(1005, 2000), recordIds: numIds(1005, 40) });
  await tw.observe({ type: 'list', identity: 'account:c', predicate: RANGE_PRED(2010, 3000), recordIds: numIds(2010, 40) });
  const last = await tw.observe({ type: 'list', identity: 'account:d', predicate: RANGE_PRED(3010, 4000), recordIds: numIds(3010, 40) });
  assert.equal(last.flagged, true);
};

// Cohort of 4: refill rate = 3.5 * 4^0.15 tokens/s, so 10 real
// seconds refill floor(43.09) = 43 tokens of the 150-token burst.
const REFILL_10S_SIZE4 = Math.floor(10 * 3.5 * Math.pow(4, 0.15));

test('cusum tripwire: bucket refill follows the monotonic clock across a +5 min wall step', async () => {
  const clocks = makeClocks();
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, now: clocks.now, monoNow: clocks.monoNow });
  await feedSlicersLive(tw);
  const drained = await tw.checkServe('account:a', 150);
  assert.equal(drained.allowed, 150); // burst bucket spent

  clocks.advanceReal(10_000);
  clocks.stepWall(300_000); // wall says 310 s elapsed - a full refill

  // Wall arithmetic would refill the bucket to full and pace nothing.
  // On the monotonic clock only 10 real seconds refilled it.
  const paced = await tw.checkServe('account:a', 150);
  assert.equal(paced.allowed, REFILL_10S_SIZE4);
  assert.equal(paced.reason, 'campaign_bucket');
});

test('cusum tripwire: bucket refill is not frozen by a -5 min wall step', async () => {
  const clocks = makeClocks();
  const tw = sdk.createCusumTripwire({ mode: 'enforce', alpha: 0.05, now: clocks.now, monoNow: clocks.monoNow });
  await feedSlicersLive(tw);
  const drained = await tw.checkServe('account:a', 150);
  assert.equal(drained.allowed, 150);

  clocks.stepWall(-300_000);
  clocks.advanceReal(10_000);

  // Wall arithmetic would see a negative elapsed time and refill
  // nothing, pacing the cohort for ~5 extra minutes. The monotonic
  // clock refilled exactly the 10 real seconds.
  const paced = await tw.checkServe('account:a', 150);
  assert.equal(paced.allowed, REFILL_10S_SIZE4);
  assert.equal(paced.reason, 'campaign_bucket');
});

const mazeReq = (path, ip) => ({
  url: `https://example.test${path}`,
  method: 'GET',
  remoteAddress: ip,
  headers: { get: () => null },
});

test('canary maze: a +5 min wall step does not reset the per-IP window early', async () => {
  const clocks = makeClocks();
  const maze = sdk.createCanaryMaze({
    enabled: true,
    windowMs: 60_000,
    maxRequestsPerIp: 3,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const ip = '203.0.113.9';
  for (let i = 0; i < 3; i++) {
    assert.equal((await maze.handle(mazeReq('/_canary/amber', ip))).status, 200);
  }
  assert.equal((await maze.handle(mazeReq('/_canary/amber', ip))).capped, true);

  clocks.advanceReal(1_000);
  clocks.stepWall(300_000); // wall says 301 s - past the 60 s window

  // The maze previously read Date.now() directly: this hit would be
  // served as a fresh window. On the monotonic clock only 1 real
  // second has passed, so the IP stays capped.
  const after = await maze.handle(mazeReq('/_canary/amber', ip));
  assert.equal(after.capped, true);
  assert.equal(after.status, 404);
});

test('canary maze: a -5 min wall step does not stretch the per-IP window', async () => {
  const clocks = makeClocks();
  const maze = sdk.createCanaryMaze({
    enabled: true,
    windowMs: 60_000,
    maxRequestsPerIp: 3,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const ip = '203.0.113.10';
  for (let i = 0; i < 3; i++) {
    assert.equal((await maze.handle(mazeReq('/_canary/amber', ip))).status, 200);
  }
  assert.equal((await maze.handle(mazeReq('/_canary/amber', ip))).capped, true);

  clocks.stepWall(-300_000);
  clocks.advanceReal(61_000); // the 60 s window has elapsed in real time

  // Wall arithmetic would keep this IP capped for ~5 more minutes.
  // On the monotonic clock the window rolled on schedule.
  const after = await maze.handle(mazeReq('/_canary/amber', ip));
  assert.equal(after.capped, undefined);
  assert.equal(after.status, 200);
});

test('evidence attribution: a +5 min wall step does not decay cross-credit', () => {
  const clocks = makeClocks();
  const attributor = sdk.createEvidenceAttributor({
    crossHalfLifeMs: 10_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  const result = attributor.attribute({ actor: 'account:a', about: 'account:b', relation: 'declared', amount: 1 });
  assert.equal(result.creditedCross, 1);
  assert.equal(attributor.crossCredit('account:a', 'account:b'), 1);

  clocks.stepWall(300_000); // 30 half-lives of wall time, zero real time

  // Wall-based decay would have erased the credit entirely; on the
  // monotonic clock no time has passed, so nothing decayed.
  assert.equal(attributor.crossCredit('account:a', 'account:b'), 1);
});

test('evidence attribution: a -5 min wall step does not freeze cross-credit decay', () => {
  const clocks = makeClocks();
  const attributor = sdk.createEvidenceAttributor({
    crossHalfLifeMs: 10_000,
    now: clocks.now,
    monoNow: clocks.monoNow,
  });
  attributor.attribute({ actor: 'account:a', about: 'account:b', relation: 'declared', amount: 1 });

  clocks.stepWall(-300_000);
  clocks.advanceReal(10_000); // exactly one half-life of real time

  // Wall-based decay would clamp the negative age to zero and keep
  // the credit at 1. On the monotonic clock one half-life elapsed.
  assert.equal(attributor.crossCredit('account:a', 'account:b'), 0.5);
});

test('replay guard: a +5 min wall step does not expire a live nonce early', () => {
  const clocks = makeClocks();
  const guard = sdk.createInMemoryReplayGuard({ ttlMs: 60_000, monoNow: clocks.monoNow });
  assert.equal(guard('nonce-a', 60_000), true);
  assert.equal(guard('nonce-a', 60_000), false); // replay while live

  clocks.stepWall(300_000);
  clocks.advanceReal(1_000); // 1 real second of the 60 s TTL

  // The guard's TTL purge runs on the monotonic clock alone: a wall
  // step cannot purge the nonce, so it is still live and this is
  // still a replay.
  assert.equal(guard('nonce-a', 60_000), false);
});

test('replay guard: a nonce expires at its monotonic TTL even when the wall clock steps back', () => {
  const clocks = makeClocks();
  const guard = sdk.createInMemoryReplayGuard({ ttlMs: 60_000, monoNow: clocks.monoNow });
  assert.equal(guard('nonce-b', 60_000), true);

  clocks.stepWall(-300_000);
  clocks.advanceReal(59_999);
  assert.equal(guard('nonce-b', 60_000), false); // still inside the TTL

  clocks.advanceReal(2); // 60_001 ms of monotonic time: past the TTL

  // A wall-based guard would keep the nonce until the wall clock
  // caught up - about 5 minutes late. On the monotonic clock it is
  // purged on schedule and the key is accepted as new.
  assert.equal(guard('nonce-b', 60_000), true);
});

test('behavior shield: route windows age on performance.now, not the wall clock', () => {
  const anomalies = [];
  let perf = 0;
  let wall = 1_700_000_000_000;
  let tickCb = null;
  const prevWindow = globalThis.window;
  const prevPerfNow = performance.now;
  const prevDateNow = Date.now;
  const win = {
    location: { pathname: '/start' },
    addEventListener() {},
    removeEventListener() {},
    setInterval(cb) { tickCb = cb; return 1; },
    clearInterval() {},
  };
  globalThis.window = win;
  performance.now = () => perf;
  Date.now = () => wall;
  try {
    const shield = new sdk.BehaviorShield({
      enabled: true,
      maxRoutesPerMinute: 15,
      onAnomaly: (_score, reason) => anomalies.push(reason),
    });
    shield.start();
    const visit = (path) => { win.location.pathname = path; tickCb(); };
    for (let i = 1; i <= 15; i++) visit(`/p${i}`);
    assert.deepEqual(anomalies, ['rapid_route_changes']);

    // A +5 min wall step must not age the events out: they are 0 s
    // old on performance.now, so the shield stays announced and a
    // second burst does not re-fire. (A Date.now-based shield would
    // prune the first burst at the step and fire again here.)
    wall += 300_000;
    for (let i = 16; i <= 30; i++) visit(`/p${i}`);
    assert.deepEqual(anomalies, ['rapid_route_changes']);

    // Advancing performance.now past the 60 s window prunes the
    // events on the next tick and resets the announced state, so a
    // fresh burst fires again.
    perf += 61_000;
    tickCb(); // same path: prune only
    for (let i = 31; i <= 45; i++) visit(`/p${i}`);
    assert.deepEqual(anomalies, ['rapid_route_changes', 'rapid_route_changes']);
    shield.stop();
  } finally {
    globalThis.window = prevWindow;
    performance.now = prevPerfNow;
    Date.now = prevDateNow;
  }
});
