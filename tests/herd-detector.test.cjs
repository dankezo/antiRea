const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * Herd-detector evidence, reproducing the lab outcomes (chains C-C6 of the
 * cross-identity correlation study) as deterministic synthetic streams.
 *
 * The lab ran at 10,000 records with budget cap 2,000/identity; these tests
 * use a 1,000-record dataset with proportionally scaled configuration
 * (combined floor 30, ramp denominator 400, cap reference 200, union floor
 * 30, min-own 5). Every other knob keeps the lab's validated value:
 * flag threshold 60, min members 3, Jaccard link ceiling 0.10, chaining
 * window 120 min, co-activity 15 min, co-active link gate 60 min, v2
 * activity window 7 days. All timestamps are explicit virtual times.
 */

const MIN = 60_000;
const DAY = 24 * 3600 * 1000;
const T0 = 1_700_000_000_000;

const scaled = (extra = {}) => ({
  combinedCoverageFloor: 30,
  coverageRampDenominator: 400,
  defaultRecordCap: 200,
  unionFloor: 30,
  minOwnRecords: 5,
  recordIndex: id => Number(id.slice(2)) - 1,
  ...extra,
});

const ids = (start, len) => Array.from({ length: len }, (_, i) => `R-${String(start + i + 1).padStart(4, '0')}`);

const feed = (det, type, identity, ts, recordIds, ip = '10.0.0.1') =>
  det.observe({ type, identity, ip, ts, ...(recordIds ? { recordIds } : {}) });

const HERD_SLICES = [[0, 200], [200, 200], [400, 200], [600, 200], [800, 100], [900, 100]];

test('(a) chained herd flags early via v1-ip with band budget_cut_supported, exactly once', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = HERD_SLICES.map((_, i) => `account:herd-a${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 20_000));
  // Two detail chunks of 10 per member, round-robin. The flag is expected
  // at combined 30 (the floor) - the lab's A1 flag point scaled by 10.
  let t = T0 + 180_000;
  for (let round = 0; round < 2; round++) {
    members.forEach((m, i) => {
      feed(det, 'detail', m, t, ids(HERD_SLICES[i][0] + round * 10, 10));
      t += 10_000;
    });
  }
  assert.equal(flags.length, 1, `expected exactly one flag, got ${flags.length}`);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'v1-ip');
  assert.equal(flag.combinedCoverage, 30);
  assert.equal(flag.band, 'budget_cut_supported');
  assert.equal(flag.members.length, 6);
  assert.equal(flag.features.tiling, 1);
  assert.ok(flag.score >= 60, `score ${flag.score}`);
});

test('(b) dispersed-signup herd flags via v2 coverage grouping, later than (a) and before half the dataset', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = HERD_SLICES.map((_, i) => `account:herd-b${i}`);
  // Signups spread over 90 virtual days: v1 chaining can never group them.
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 18 * DAY));
  // Extraction is concurrent and contiguous per identity (the C4b shape
  // that C5's complement grouping closed at combined 2,400 of 10,000).
  let t = T0 + 95 * DAY;
  const pos = HERD_SLICES.map(() => 0);
  let remaining = true;
  while (remaining) {
    remaining = false;
    members.forEach((m, i) => {
      if (pos[i] < HERD_SLICES[i][1]) {
        feed(det, 'detail', m, t, ids(HERD_SLICES[i][0] + pos[i], 10));
        pos[i] += 10;
        t += 30_000;
        if (pos[i] < HERD_SLICES[i][1]) remaining = true;
      }
    });
  }
  assert.equal(flags.length, 1, `expected exactly one flag, got ${flags.length}`);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'v2-coverage');
  assert.equal(flag.features.cluster, null, 'v2 score drops the cluster term');
  assert.ok(
    flag.combinedCoverage >= 200 && flag.combinedCoverage < 500,
    `v2 flag at combined ${flag.combinedCoverage} (lab: 2,400 of 10,000 = 24%)`,
  );
  assert.equal(flag.band, 'budget_cut_supported');
});

test('(c) interleaved + dispersed herd does NOT flag - the known evader, asserted as a limit', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = Array.from({ length: 6 }, (_, i) => `account:herd-c${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 18 * DAY));
  // The dataset is dealt in blocks of 10 round-robin (scaled from the
  // lab's 100-record blocks): each identity's set is strided blocks, so
  // contiguity collapses and scoreV2 peaks below the threshold (lab:
  // 57.3 of 60) even though v2 groups the herd.
  let t = T0 + 95 * DAY;
  for (let b = 0; b < 100; b++) {
    feed(det, 'detail', members[b % 6], t, ids(b * 10, 10));
    t += 30_000;
  }
  assert.equal(flags.length, 0, 'the combined dispersed+interleaved shape must stay unflagged');
  const coverage = det.groups().filter(g => g.mechanism === 'v2-coverage' && g.members.length >= 3);
  assert.equal(coverage.length, 1, 'v2 still groups the herd - the miss is in the score, not the grouping');
  assert.equal(coverage[0].combinedCoverage, 1000);
  assert.ok(
    coverage[0].maxScore < 60 && coverage[0].maxScore > 40,
    `evader group peak score ${coverage[0].maxScore} (lab: 57.3)`,
  );
});

test('(d) dense legit colleagues with high overlap never flag and never link', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = [0, 1, 2, 3].map(i => `account:collab${i}`);
  // Same-morning signups, 9 virtual-min apart: they DO chain into one
  // v1 group (the C4a gauntlet profile).
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 9 * MIN));
  const prefixLens = [75, 65, 55, 45];
  const streams = members.map((m, u) => {
    const evs = [];
    for (let p = 0; p < prefixLens[u]; p += 10) evs.push(['list', ids(p, Math.min(10, prefixLens[u] - p))]);
    for (let i = 0; i < 32; i++) {
      const idx = i < 22 ? (i * 37 + u * 11) % 150 : (i * 131 + u * 57) % 1000;
      evs.push(['detail', ids(idx, 1)]);
    }
    return evs;
  });
  // Interleaved rounds, as in the lab: everyone stays co-active.
  let t = T0 + 40 * MIN;
  const maxLen = Math.max(...streams.map(s => s.length));
  for (let k = 0; k < maxLen; k++) {
    members.forEach((m, u) => {
      const ev = streams[u][k];
      if (ev) {
        feed(det, ev[0], m, t, ev[1]);
        t += 30_000;
      }
    });
  }
  assert.equal(flags.length, 0, 'colleagues must never flag (lab gauntlet peak: 47.2 of 60)');
  const ipGroup = det.groups().find(g => g.mechanism === 'v1-ip');
  assert.ok(ipGroup && ipGroup.members.length === 4, 'the colleagues chained into one v1 group');
  assert.ok(ipGroup.maxScore < 60, `colleague group peak ${ipGroup.maxScore}`);
  assert.equal(ipGroup.features.tiling, 0, 'colleagues overlap; herds partition');
  const linked = det.groups().filter(g => g.mechanism === 'v2-coverage' && g.members.length > 1);
  assert.equal(linked.length, 0, 'pairwise Jaccard stays far above the link ceiling: no v2 links');
});

test('(e) light NAT users sharing one IP never flag', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = [0, 1, 2, 3, 4].map(i => `account:nat${i}`);
  const gapsMin = [0, 90, 255, 400, 470];
  members.forEach((m, i) => feed(det, 'signup', m, T0 + gapsMin[i] * MIN));
  members.forEach((m, u) => {
    let t = T0 + gapsMin[u] * MIN + 10 * MIN;
    for (let p = 0; p < 30; p += 10) {
      feed(det, 'list', m, t, ids(p, 10));
      t += 5 * MIN;
    }
    for (let i = 0; i < 8; i++) {
      feed(det, 'detail', m, t, ids((i * 3 + u) % 20, 1));
      t += 5 * MIN;
    }
  });
  assert.equal(flags.length, 0);
  const big = det.groups().filter(g => g.members.length >= 3);
  assert.equal(big.length, 0, 'chaining splits the workday into groups of at most 2; v2 never links near-identical sets');
});

test('(f) audit-team profile flags only as graduated_only and the ladder refuses to cut', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = [0, 1, 2].map(i => `account:audit${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 15 * MIN));
  // Segment [200,500): a shared 45-record QC slice plus a disjoint
  // 85-record third per reviewer (the C6 arm-4 profile, scaled by 10).
  // Pairwise Jaccard = 45/215 = 0.21, above the v2 link ceiling.
  const streams = members.map((_, u) => {
    const evs = [];
    for (let p = 0; p < 45; p += 9) evs.push(ids(200 + p, 9));
    const start = 245 + u * 85;
    for (let p = 0; p < 85; p += 10) evs.push(ids(start + p, Math.min(10, 85 - p)));
    return evs;
  });
  let t = T0 + 60 * MIN;
  const maxLen = Math.max(...streams.map(s => s.length));
  for (let k = 0; k < maxLen; k++) {
    members.forEach((m, u) => {
      if (streams[u][k]) {
        feed(det, 'detail', m, t, streams[u][k]);
        t += 2 * MIN;
      }
    });
  }
  assert.equal(flags.length, 1, `expected the audit team to graze the flag exactly once, got ${flags.length}`);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'v1-ip');
  assert.equal(flag.band, 'graduated_only', 'low tiling: uniform coverage by job description is not the herd partition profile');
  assert.ok(flag.features.tiling < 0.5, `tiling ${flag.features.tiling}`);
  // The band policy is encoded in the ladder: it must refuse, and the
  // members' budgets must be untouched.
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 200 });
  const res = sdk.applyHerdLadder(budget, flag, { memberLimit: 10 });
  assert.equal(res.applied, false);
  assert.equal(res.reason, 'graduated_only');
  assert.deepEqual(res.identities, []);
  for (const m of flag.members) assert.equal(budget.usage(m).limit, 200);
});

test('(g) applyHerdLadder cuts member budgets on a budget_cut_supported flag', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const slices = [[0, 200], [200, 200], [400, 200]];
  const members = slices.map((_, i) => `account:herd-g${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 20_000));
  let t = T0 + 180_000;
  members.forEach((m, i) => {
    feed(det, 'detail', m, t, ids(slices[i][0], 10));
    t += 10_000;
  });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].band, 'budget_cut_supported');
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 200 });
  const res = sdk.applyHerdLadder(budget, flags[0], { memberLimit: 10 });
  assert.equal(res.applied, true);
  assert.deepEqual([...res.identities].sort(), [...members].sort());
  for (const m of members) assert.equal(budget.usage(m).limit, 10);
});
