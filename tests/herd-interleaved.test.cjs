const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * L8b: the union-growth candidate feature (PREREG-V261 L8b, RESEARCH
 * item 4A). The dispersed + interleaved herd of herd-detector.test.cjs
 * (c) groups under v2 but peaks at 57.3 of 60 under the shipped
 * weights, because interleaving collapses the contiguity term. The
 * candidate feature - union growth (the share of served records that
 * grew the group's union, combined / sum of member sizes) discounted
 * by contiguity - is computed on every snapshot but weighted 0 in
 * DEFAULT_HERD_WEIGHTS, so the shipped scoring is untouched. These
 * tests opt in with `weights: { unionGrowth: 0.15 }` (the contiguity
 * weight: a perfectly partitioning group earns the assembly term in
 * full whether its slices arrive contiguously or interleaved) and
 * assert the pre-registered bars: the evader flags, the colleague
 * control peak stays < 60, the shared-IP control never flags.
 * Streams replicate herd-detector.test.cjs exactly (same scaled
 * configuration, same virtual times).
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
const OPT_IN = { weights: { unionGrowth: 0.15 } };

const ids = (start, len) => Array.from({ length: len }, (_, i) => `R-${String(start + i + 1).padStart(4, '0')}`);

const feed = (det, type, identity, ts, recordIds, ip = '10.0.0.1') =>
  det.observe({ type, identity, ip, ts, ...(recordIds ? { recordIds } : {}) });

const feedEvader = det => {
  const members = Array.from({ length: 6 }, (_, i) => `account:herd-c${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 18 * DAY));
  let t = T0 + 95 * DAY;
  for (let b = 0; b < 100; b++) {
    feed(det, 'detail', members[b % 6], t, ids(b * 10, 10));
    t += 30_000;
  }
};

test('L8b: interleaved + dispersed herd flags with the union-growth feature opted in', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ ...OPT_IN, onFlag: s => flags.push(s) }));
  feedEvader(det);
  assert.equal(flags.length, 1, `expected exactly one flag, got ${flags.length}`);
  const flag = flags[0];
  assert.equal(flag.mechanism, 'v2-coverage');
  assert.ok(flag.score >= 60, `score ${flag.score}`);
  assert.equal(flag.combinedCoverage, 240);
  assert.equal(flag.features.unionGrowth, 0.75, 'union growth through fragmentation at flag time');
  assert.equal(flag.band, 'budget_cut_supported');
  const coverage = det.groups().filter(g => g.mechanism === 'v2-coverage' && g.members.length >= 3);
  assert.equal(coverage.length, 1);
  assert.ok(coverage[0].maxScore >= 60, `evader group peak ${coverage[0].maxScore}`);
});

test('L8b: the same shape under the shipped default weights still does not flag (scoring untouched)', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  assert.equal(sdk.DEFAULT_HERD_WEIGHTS.unionGrowth, 0, 'union growth is opt-in only');
  feedEvader(det);
  assert.equal(flags.length, 0);
  const coverage = det.groups().filter(g => g.mechanism === 'v2-coverage' && g.members.length >= 3);
  assert.equal(coverage.length, 1);
  assert.ok(
    coverage[0].maxScore < 60 && coverage[0].maxScore > 40,
    `default-weights peak ${coverage[0].maxScore} (lab: 57.3)`,
  );
  assert.ok(coverage[0].features.unionGrowth > 0.9, 'the feature is computed even at weight 0');
});

test('L8b: dense legit colleagues never flag with the feature opted in; peak stays < 60', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ ...OPT_IN, onFlag: s => flags.push(s) }));
  const members = [0, 1, 2, 3].map(i => `account:collab${i}`);
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
  assert.equal(flags.length, 0, 'colleagues must never flag with the feature on');
  const ipGroup = det.groups().find(g => g.mechanism === 'v1-ip');
  assert.ok(ipGroup && ipGroup.members.length === 4);
  assert.ok(ipGroup.maxScore < 60, `colleague group peak ${ipGroup.maxScore} with the feature on`);
});

test('L8b: light NAT users sharing one IP never flag with the feature opted in', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ ...OPT_IN, onFlag: s => flags.push(s) }));
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
  assert.equal(flags.length, 0, 'shared-IP workday control must never flag with the feature on');
  const big = det.groups().filter(g => g.members.length >= 3);
  assert.equal(big.length, 0);
});
