const { test } = require('node:test');
const assert = require('node:assert/strict');
// Tests import the compiled module directly (the herd-tightness
// tests use the same subpath pattern).
const sdk = require('../dist/tier2-active/prefix-crowding-signal.js');
const { createPrefixCrowdingSignal, PrefixCrowdingError, slash24BucketLabel, asnBucketLabel } = sdk;

// ---------------------------------------------------------------------------
// Prefix crowding signal (CS-03 PrefixCrowding, Step 0 PASS-lab,
// seed 20299811; REGISTRATION-CS-03-PrefixCrowding-STEP0.md and
// CS-03-STEP0-RESULTS.md in the study tree).
//
// The frozen registration defines gates P1-P3 only (the inventory
// summary mentions P1-P5; no P4 or P5 exists in the lab record, and
// none is invented here):
//   P1 - zero flagged windows among the 5 scored legit windows.
//   P2 - the synthetic fleet window flags under placement A (one
//        fresh bucket, 40 identities). Placement B is descriptive.
//   P3 - per-window scoring cost at or below 10 ms.
//
// Fixture construction: the lab model drew home buckets from a
// seeded mulberry32 stream (seed 20299811); its recorded outputs
// used here are the NAT bucket label B48 and the five scored
// windows' totals, B48 shares and B48 saturations from
// cs03-results.json. The SDK module consumes host-supplied labels
// only, so the fixtures rebuild each window from those recorded
// numbers: B48 holds the recorded NAT count, and every other
// active identity sits alone in its own persistent solo bucket
// (share 1/n, never near the bar). The baseline-only first window
// (2026-11-02) is rebuilt with B48 share 1/6 (10 of 60), the value
// the recorded second window's saturation pins exactly:
// 0.25 / 1.5 = 0.16666...
// ---------------------------------------------------------------------------

const NAT_BUCKET = 'B48'; // drawn by the seeded lab model, seed 20299811

function windowEntries(natCount, total) {
  const entries = [];
  for (let i = 0; i < natCount; i++) entries.push({ identity: `nat-${i}`, bucket: NAT_BUCKET });
  const solo = total - natCount;
  for (let i = 0; i < solo; i++) entries.push({ identity: `solo-${i}`, bucket: `B-solo-${i}` });
  return entries;
}

// The six legit windows of the lab probe: window 0 is baseline-only,
// windows 1-5 are the scored windows recorded in cs03-results.json.
const LEGIT_WINDOWS = [
  { day: '2026-11-02', n: 60, nat: 10 },
  { day: '2026-11-03', n: 24, nat: 6 },
  { day: '2026-11-04', n: 78, nat: 17 },
  { day: '2026-11-05', n: 60, nat: 16 },
  { day: '2026-11-06', n: 126, nat: 24 },
  { day: '2026-11-07', n: 72, nat: 23 },
];

// Recorded scored windows (cs03-results.json): B48 share and saturation.
const RECORDED_SCORED = [
  { day: '2026-11-03', n: 24, share: 0.25, saturation: 1.5 },
  { day: '2026-11-04', n: 78, share: 0.21794871794871795, saturation: 1.0461538461538462 },
  { day: '2026-11-05', n: 60, share: 0.26666666666666666, saturation: 1.2606060606060605 },
  { day: '2026-11-06', n: 126, share: 0.19047619047619047, saturation: 0.8453566348303191 },
  { day: '2026-11-07', n: 72, share: 0.3194444444444444, saturation: 1.4629816026393783 },
];

function feedLegit(signal) {
  return LEGIT_WINDOWS.map((w) =>
    signal.observeWindow({ windowId: w.day, entries: windowEntries(w.nat, w.n) }),
  );
}

function approx(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${label}: ${actual} vs recorded ${expected}`);
}

test('P1: zero flagged legit windows, with the recorded B48 shares and saturations', () => {
  const signal = createPrefixCrowdingSignal();
  const results = feedLegit(signal);
  // Window 0 is baseline-only and never scored.
  assert.equal(results[0].status, 'baseline_only');
  assert.equal(results[0].flagged, false);
  assert.equal(results[0].worstBucket.bucket, NAT_BUCKET);
  approx(results[0].worstBucket.share, 1 / 6, 'baseline B48 share');
  assert.equal(results[0].worstBucket.saturation, null);
  // The five scored windows reproduce the lab record exactly, and
  // none flags: the AND condition protects the office-NAT bucket.
  for (let i = 0; i < RECORDED_SCORED.length; i++) {
    const result = results[i + 1];
    const recorded = RECORDED_SCORED[i];
    assert.equal(result.status, 'scored');
    assert.equal(result.windowId, recorded.day);
    assert.equal(result.activeIdentities, recorded.n);
    assert.equal(result.flagged, false, `window ${recorded.day} must not flag (P1)`);
    assert.equal(result.flaggedBuckets.length, 0);
    assert.equal(result.worstBucket.bucket, NAT_BUCKET);
    approx(result.worstBucket.share, recorded.share, `${recorded.day} share`);
    approx(result.worstBucket.saturation, recorded.saturation, `${recorded.day} saturation`);
    assert.equal(result.worstBucket.flagged, false);
  }
  // The last window is the designed near-miss: share crosses the
  // 0.30 bar but saturation (1.463) stays below 2.0.
  const last = results[5];
  assert.ok(last.worstBucket.share >= 0.3);
  assert.ok(last.worstBucket.saturation < 2.0);
  const snap = signal.snapshot();
  assert.equal(snap.windows, 6);
  assert.equal(snap.windowsScored, 5);
  assert.equal(snap.windowsFlagged, 0);
  assert.equal(snap.enforcement, 'none');
});

test('P2: fleet placement A (40 in one fresh bucket) flags at the recorded share', () => {
  const signal = createPrefixCrowdingSignal();
  feedLegit(signal);
  const base = windowEntries(23, 72);
  const fleet = [];
  for (let i = 0; i < 40; i++) fleet.push({ identity: `fleet-${i}`, bucket: 'B-fleet-A' });
  const result = signal.observeWindow({ windowId: 'fleet-A', entries: [...base, ...fleet] });
  assert.equal(result.activeIdentities, 112);
  assert.equal(result.flagged, true);
  assert.equal(result.flaggedBuckets.length, 1);
  const bucket = result.flaggedBuckets[0];
  assert.equal(bucket.bucket, 'B-fleet-A');
  assert.equal(bucket.identities, 40);
  approx(bucket.share, 0.35714285714285715, 'fleet A share');
  // Zero baseline plus share at or above the bar: saturation is
  // +Infinity by the frozen rule.
  assert.equal(bucket.baselineShare, 0);
  assert.equal(bucket.saturation, Infinity);
  assert.equal(result.worstBucket.bucket, 'B-fleet-A');
});

test('blind spot: fleet placement B (20 + 20 split) does not flag, as recorded', () => {
  const signal = createPrefixCrowdingSignal();
  feedLegit(signal);
  const base = windowEntries(23, 72);
  const fleet = [];
  for (let i = 0; i < 20; i++) fleet.push({ identity: `fleet-b0-${i}`, bucket: 'B-fleet-0' });
  for (let i = 0; i < 20; i++) fleet.push({ identity: `fleet-b1-${i}`, bucket: 'B-fleet-1' });
  const result = signal.observeWindow({ windowId: 'fleet-B', entries: [...base, ...fleet] });
  assert.equal(result.activeIdentities, 112);
  // Descriptive only in the lab, and the honest limit of the
  // statistic: a split fleet dilutes itself under the share bar.
  assert.equal(result.flagged, false);
  assert.equal(result.flaggedBuckets.length, 0);
  for (const label of ['B-fleet-0', 'B-fleet-1']) {
    const bucket = result.buckets.find((b) => b.bucket === label);
    approx(bucket.share, 0.17857142857142858, `${label} share`);
    // Zero baseline below the share bar reads saturation 0.
    assert.equal(bucket.saturation, 0);
    assert.equal(bucket.flagged, false);
  }
  assert.ok(signal.snapshot().notice.includes('split'));
});

test('P3: per-window scoring cost stays under the 10 ms lab budget (median)', () => {
  const entries = [...windowEntries(23, 72)];
  for (let i = 0; i < 40; i++) entries.push({ identity: `fleet-${i}`, bucket: 'B-fleet-A' });
  const costs = [];
  for (let run = 0; run < 21; run++) {
    const signal = createPrefixCrowdingSignal();
    feedLegit(signal);
    const t0 = process.hrtime.bigint();
    signal.observeWindow({ windowId: 'fleet-A', entries });
    costs.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  costs.sort((a, b) => a - b);
  const median = costs[Math.floor(costs.length / 2)];
  assert.ok(median <= 10, `median cost ${median} ms exceeds the 10 ms P3 budget`);
});

test('baseline-only first window never flags, even at share 1', () => {
  const signal = createPrefixCrowdingSignal();
  const entries = [];
  for (let i = 0; i < 50; i++) entries.push({ identity: `only-${i}`, bucket: 'B-only' });
  const result = signal.observeWindow({ entries });
  assert.equal(result.status, 'baseline_only');
  assert.equal(result.flagged, false);
  assert.equal(result.worstBucket.share, 1);
  assert.equal(result.worstBucket.baselineShare, null);
});

test('AND condition: saturation alone does not flag below the share bar', () => {
  const signal = createPrefixCrowdingSignal();
  // Baseline window: bucket BX holds 5 of 100 (share 0.05).
  const baseline = [];
  for (let i = 0; i < 5; i++) baseline.push({ identity: `x-${i}`, bucket: 'BX' });
  for (let i = 0; i < 95; i++) baseline.push({ identity: `s-${i}`, bucket: `B-solo-${i}` });
  signal.observeWindow({ entries: baseline });
  // Scored window: BX triples to 15 of 100 (share 0.15, saturation
  // 3.0) but stays below the 0.30 share bar, so no flag.
  const scored = [];
  for (let i = 0; i < 15; i++) scored.push({ identity: `x-${i}`, bucket: 'BX' });
  for (let i = 0; i < 85; i++) scored.push({ identity: `s-${i}`, bucket: `B-solo-${i}` });
  const result = signal.observeWindow({ entries: scored });
  const bucket = result.buckets.find((b) => b.bucket === 'BX');
  approx(bucket.share, 0.15, 'BX share');
  approx(bucket.saturation, 3.0, 'BX saturation');
  assert.equal(bucket.flagged, false);
  assert.equal(result.flagged, false);
});

test('host label helpers: /24 derivation and ASN passthrough only', () => {
  assert.equal(slash24BucketLabel('203.0.113.87'), '203.0.113.0/24');
  assert.equal(slash24BucketLabel('10.0.0.1'), '10.0.0.0/24');
  assert.equal(slash24BucketLabel('999.1.1.1'), null);
  assert.equal(slash24BucketLabel('203.0.113'), null);
  // No IPv6 bucketing assumption is built in.
  assert.equal(slash24BucketLabel('2001:db8::1'), null);
  assert.equal(slash24BucketLabel('not-an-ip'), null);
  assert.equal(asnBucketLabel('AS13335'), 'AS13335');
  assert.equal(asnBucketLabel('AS-EXAMPLE-1'), 'AS-EXAMPLE-1');
  assert.equal(asnBucketLabel(''), null);
});

test('distinct identities: duplicate entries count once, first bucket wins', () => {
  const signal = createPrefixCrowdingSignal();
  const result = signal.observeWindow({
    entries: [
      { identity: 'a', bucket: 'B1' },
      { identity: 'a', bucket: 'B2' },
      { identity: 'a', bucket: 'B1' },
      { identity: 'b', bucket: 'B2' },
    ],
  });
  assert.equal(result.activeIdentities, 2);
  assert.equal(result.buckets.find((b) => b.bucket === 'B1').identities, 1);
  assert.equal(result.buckets.find((b) => b.bucket === 'B2').identities, 1);
  const snap = signal.snapshot();
  assert.equal(snap.counters.duplicateEntries, 2);
  assert.equal(snap.counters.conflictingEntries, 1);
});

test('empty window does not advance the baseline', () => {
  const signal = createPrefixCrowdingSignal();
  const empty = signal.observeWindow({ entries: [] });
  assert.equal(empty.status, 'empty_window');
  assert.equal(empty.flagged, false);
  const next = signal.observeWindow({ entries: [{ identity: 'a', bucket: 'B1' }] });
  assert.equal(next.status, 'baseline_only');
  assert.equal(signal.snapshot().counters.emptyWindows, 1);
  assert.equal(signal.snapshot().windows, 1);
});

test('custom bars are honoured: a lower share bar flags the split fleet shape', () => {
  // This does not contradict the blind-spot record: at the frozen
  // bars the split fleet does not flag. It pins that the bars are
  // host configuration, not hidden constants.
  const signal = createPrefixCrowdingSignal({ shareBar: 0.15, saturationBar: 2.0 });
  feedLegit(signal);
  const base = windowEntries(23, 72);
  const fleet = [];
  for (let i = 0; i < 20; i++) fleet.push({ identity: `fleet-b0-${i}`, bucket: 'B-fleet-0' });
  for (let i = 0; i < 20; i++) fleet.push({ identity: `fleet-b1-${i}`, bucket: 'B-fleet-1' });
  const result = signal.observeWindow({ entries: [...base, ...fleet] });
  assert.equal(result.flagged, true);
  assert.equal(result.flaggedBuckets.length, 2);
});

test('invalid inputs throw PrefixCrowdingError', () => {
  assert.throws(() => createPrefixCrowdingSignal({ shareBar: 0 }), PrefixCrowdingError);
  assert.throws(() => createPrefixCrowdingSignal({ shareBar: 1.5 }), PrefixCrowdingError);
  assert.throws(() => createPrefixCrowdingSignal({ saturationBar: -1 }), PrefixCrowdingError);
  const signal = createPrefixCrowdingSignal();
  assert.throws(() => signal.observeWindow({ entries: [{ identity: '', bucket: 'B1' }] }), PrefixCrowdingError);
  assert.throws(() => signal.observeWindow({ entries: [{ identity: 'a', bucket: '' }] }), PrefixCrowdingError);
  assert.throws(() => signal.observeWindow({ entries: 'nope' }), PrefixCrowdingError);
});

test('index export: createPrefixCrowdingSignal is part of the public SDK surface', () => {
  const index = require('../dist/index.js');
  assert.equal(typeof index.createPrefixCrowdingSignal, 'function');
  assert.equal(typeof index.slash24BucketLabel, 'function');
  assert.equal(typeof index.asnBucketLabel, 'function');
  assert.equal(typeof index.PrefixCrowdingError, 'function');
});
