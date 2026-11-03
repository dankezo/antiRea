const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// Cleanup B1 (audit 2.6.0 LOW findings, retest on the 2.7.0 tree):
//   F-17 action-cohort evaluateAction reported a stale flag forever.
//   F-18 action-cohort subjects/groups outlived the activity window.
//   F-20 herd recordIndex / getLimit and action-cohort getAllowance
//        were invoked bare - a throw escaped observe() and (herd
//        recordIndex) left group aggregates permanently short.
//   F-21 an out-of-Date-range ts made herd observe() throw a bare
//        RangeError after the flag latch was set (flag lost forever);
//        in action-cohort the same ts wiped the action's grouping
//        state via the window prune. Both now refuse the event
//        cleanly: { recorded: false }, no throw, no state touched.
// Every test below fails on the pre-fix build and passes after it
// (pre-fix behaviour recorded in the cleanup notes, harness
// /tmp/repro-b1*.cjs + the audit's own regress-h8.cjs).

const T0 = 1_700_000_000_000;
const WINDOW = 900_000; // shipped action-cohort activity window
const MAX_DATE_MS = 8_640_000_000_000_000;
const ids = (start, len) => Array.from({ length: len }, (_, i) => `R-${String(start + i + 1).padStart(4, '0')}`);

function feedPair(tracker, subject, firstSlice) {
  tracker.observe({ subject, action: 'export', targetKey: `slice:${firstSlice}`, cost: 8 });
  return tracker.observe({ subject, action: 'export', targetKey: `slice:${firstSlice + 1}`, cost: 8 });
}

/* ------------------------------- F-17 ------------------------------- */

test('F-17: evaluateAction prunes a fully expired flagged cluster - no stale flag after 2x window', () => {
  let clock = T0;
  const flags = [];
  const tracker = sdk.createActionCohortTracker({ onFlag: s => flags.push(s), now: () => clock });
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1);
  const groupId = flags[0].groupId;

  // Control: while the group is live, the flagged cluster is reported.
  const live = tracker.evaluateAction({ subject: 'account:new', action: 'export', targetKey: 'slice:999', cost: 8 });
  const liveEntry = live.clusters.find(c => c.groupId === groupId);
  assert.ok(liveEntry, 'live flagged cluster is reported');
  assert.equal(liveEntry.flagged, true);
  assert.equal(liveEntry.wouldJoin, true);

  // After 2x the activity window with no activity, the same call must
  // not report the dead group's flag (pre-fix: flagged stayed true).
  clock += 2 * WINDOW;
  const stale = tracker.evaluateAction({ subject: 'account:new', action: 'export', targetKey: 'slice:999', cost: 8 });
  assert.deepEqual(stale.clusters, [], 'expired cluster is pruned from the evaluation');
  assert.deepEqual(stale.sharedTargets, []);
});

test('F-17: evaluateAction prunes a fully expired flagged shared-target group', () => {
  let clock = T0;
  const flags = [];
  const tracker = sdk.createActionCohortTracker({ onFlag: s => flags.push(s), now: () => clock });
  for (let i = 0; i < 6; i++) {
    tracker.observe({ subject: `account:p${i}`, action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  }
  assert.equal(flags.length, 1);
  const live = tracker.evaluateAction({ subject: 'account:p9', action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  assert.deepEqual(live.sharedTargets, [{ action: 'promo_claim', targetKey: 'promo:1', flagged: true, subjectCount: 6 }]);

  clock += 2 * WINDOW;
  const stale = tracker.evaluateAction({ subject: 'account:p9', action: 'promo_claim', targetKey: 'promo:1', cost: 20 });
  assert.deepEqual(stale.sharedTargets, [], 'expired shared-target group is pruned from the evaluation');
});

/* ------------------------------- F-18 ------------------------------- */

test('F-18: after 2x window idle, groups() falls to zero with no reset()', () => {
  let clock = T0;
  const tracker = sdk.createActionCohortTracker({ now: () => clock });
  tracker.observe({ subject: 'account:a', action: 'export', targetKey: 'slice:0', cost: 5 });
  tracker.observe({ subject: 'account:b', action: 'search', targetKey: 'corpus:1', cost: 5 });
  tracker.observe({ subject: 'account:c', action: 'promo_claim', targetKey: 'promo:1', cost: 5 });
  tracker.observe({ subject: 'account:d', action: 'export', cost: 5 }); // subject-only state (no target)
  assert.equal(tracker.groups().length, 6, '3 complement clusters + 3 shared-target groups are live');

  clock += 2 * WINDOW + 1;
  assert.deepEqual(tracker.groups(), [], 'every group expired out of the window - no reset needed');

  // A fresh event afterwards starts from a clean tracker: only its
  // own groups exist (nothing stale is resurrected).
  tracker.observe({ subject: 'account:e', action: 'export', targetKey: 'slice:9', cost: 5 });
  const after = tracker.groups();
  assert.equal(after.length, 2, 'one complement cluster + one shared-target group for the new event');
  assert.ok(after.every(g => g.members.length === 1 && g.members[0] === 'account:e'));
});

test('F-18: expired per-subject window cost no longer feeds the dilution gate', () => {
  let clock = T0;
  const flags = [];
  const tracker = sdk.createActionCohortTracker({ onFlag: s => flags.push(s), now: () => clock });
  // Four of the future herd members blow their allowance (default 100)
  // with target-less export events: window cost 150 each.
  for (let i = 0; i < 4; i++) {
    for (let k = 0; k < 3; k++) tracker.observe({ subject: `account:s${i}`, action: 'export', cost: 50 });
  }
  // The herd shape itself: with 4/8 members over allowance, only 50%
  // are at-or-below, below the 60% dilution gate -> no complement flag.
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 0, 'dilution gate blocks the flag while the heavy costs are in-window');

  // After the window, the stale costs (and the stale herd events) are
  // gone: re-feeding the same herd shape flags, because every member's
  // live window cost (16) is back under its allowance.
  clock += 2 * WINDOW + 1;
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1, 'the same shape flags once the expired costs leave the window');
  assert.equal(flags[0].mechanism, 'complement');
});

/* ------------------------------- F-20 ------------------------------- */

test('F-20: action-cohort getAllowance throw is swallowed - observe completes and the flag still fires', () => {
  const flags = [];
  const tracker = sdk.createActionCohortTracker({
    onFlag: s => flags.push(s),
    getAllowance: () => { throw new Error('host allowance boom'); },
  });
  // Pre-fix: the flag-completing observe threw the host error bare.
  for (let i = 0; i < 8; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 1, 'fallback allowance (default 100) lets the dilution gate pass and the flag fire');
  assert.equal(flags[0].mechanism, 'complement');
});

test('F-20: herd recordIndex throw mid-loop - observe completes, no orphan keys in group aggregates', () => {
  const det = sdk.createHerdDetector({
    combinedCoverageFloor: 30, coverageRampDenominator: 400, defaultRecordCap: 200,
    unionFloor: 30, minOwnRecords: 5,
    recordIndex: id => { if (id === 'R-0002') throw new Error('index boom'); return Number(id.slice(2)) - 1; },
  });
  det.observe({ type: 'signup', identity: 'account:x', ip: '10.0.0.1', ts: T0 });
  // Pre-fix: this threw, R-0001/R-0002 sat in the identity's key set
  // but were never folded into the v1 aggregate (combined stayed 0,
  // and a re-feed only ever recovered the non-throwing tail).
  const obs = det.observe({ type: 'detail', identity: 'account:x', ip: '10.0.0.1', ts: T0 + 1000, recordIds: ['R-0001', 'R-0002', 'R-0003'] });
  assert.equal(obs.recorded, true);
  const ipGroup = det.groups().find(g => g.mechanism === 'v1-ip');
  assert.equal(ipGroup.combinedCoverage, 3, 'all three ids folded, including the one whose index lookup threw');
  // Re-feeding the same ids changes nothing (no double count, no loss).
  det.observe({ type: 'detail', identity: 'account:x', ip: '10.0.0.1', ts: T0 + 2000, recordIds: ['R-0001', 'R-0002', 'R-0003'] });
  assert.equal(det.groups().find(g => g.mechanism === 'v1-ip').combinedCoverage, 3);
});

test('F-20: herd getLimit throw is swallowed - observe completes and cap pressure uses the default cap', () => {
  const cfg = {
    combinedCoverageFloor: 30, coverageRampDenominator: 30, defaultRecordCap: 10,
    unionFloor: 30, minOwnRecords: 5, recordIndex: id => Number(id.slice(2)) - 1,
  };
  const flags = [];
  const det = sdk.createHerdDetector({ ...cfg, onFlag: s => flags.push(s), getLimit: () => { throw new Error('limit boom'); } });
  const members = [0, 1, 2].map(i => `account:h${i}`);
  members.forEach((m, i) => det.observe({ type: 'signup', identity: m, ip: '10.0.0.1', ts: T0 + i * 20_000 }));
  // Pre-fix: the first detail observe threw the host error bare.
  members.forEach((m, i) => {
    const obs = det.observe({ type: 'detail', identity: m, ip: '10.0.0.1', ts: T0 + 100_000 + i * 10_000, recordIds: ids(i * 200, 10) });
    assert.equal(obs.recorded, true);
  });
  assert.equal(flags.length, 1, 'the herd still flags with the fallback cap');
});

/* ------------------------------- F-21 ------------------------------- */

test('F-21 herd: out-of-range / non-finite ts is refused cleanly - no throw, no state, later events unaffected', () => {
  const det = sdk.createHerdDetector({
    combinedCoverageFloor: 30, coverageRampDenominator: 400, defaultRecordCap: 200,
    unionFloor: 30, minOwnRecords: 5, recordIndex: id => Number(id.slice(2)) - 1,
  });
  det.observe({ type: 'signup', identity: 'account:z', ip: '10.0.0.3', ts: T0 });
  for (const badTs of [1e16, -1e16, MAX_DATE_MS + 1, NaN, Infinity, -Infinity]) {
    const obs = det.observe({ type: 'detail', identity: 'account:z', ip: '10.0.0.3', ts: badTs, recordIds: ['R-0001'] });
    assert.equal(obs.recorded, false, `ts=${String(badTs)} refused`);
    assert.equal(obs.flag, undefined);
  }
  // No state was touched: no coverage, no v2 group was created.
  assert.equal(det.groups().find(g => g.mechanism === 'v1-ip').combinedCoverage, 0);
  assert.equal(det.groups().filter(g => g.mechanism === 'v2-coverage').length, 0);
  // The boundary itself is a valid Date and is accepted.
  const edge = det.observe({ type: 'detail', identity: 'account:z', ip: '10.0.0.3', ts: MAX_DATE_MS, recordIds: ['R-0001'] });
  assert.equal(edge.recorded, true, 'ts exactly at the Date maximum is valid');
  // And ordinary events keep working afterwards.
  det.reset();
  det.observe({ type: 'signup', identity: 'account:z', ip: '10.0.0.3', ts: T0 });
  const ok = det.observe({ type: 'detail', identity: 'account:z', ip: '10.0.0.3', ts: T0 + 1000, recordIds: ['R-0001'] });
  assert.equal(ok.recorded, true);
  assert.equal(det.groups().find(g => g.mechanism === 'v1-ip').combinedCoverage, 1);
});

test('F-21 herd: the flag-carrying event with ts=1e16 loses nothing - a good re-feed delivers the flag', () => {
  const cfg = {
    combinedCoverageFloor: 30, coverageRampDenominator: 30, defaultRecordCap: 10,
    unionFloor: 30, minOwnRecords: 5, recordIndex: id => Number(id.slice(2)) - 1,
  };
  const flags = [];
  const det = sdk.createHerdDetector({ ...cfg, onFlag: s => flags.push(s) });
  const members = [0, 1, 2].map(i => `account:h${i}`);
  members.forEach((m, i) => det.observe({ type: 'signup', identity: m, ip: '10.0.0.1', ts: T0 + i * 20_000 }));
  det.observe({ type: 'detail', identity: members[0], ip: '10.0.0.1', ts: T0 + 100_000, recordIds: ids(0, 10) });
  det.observe({ type: 'detail', identity: members[1], ip: '10.0.0.1', ts: T0 + 110_000, recordIds: ids(200, 10) });
  // This event would cross the combined floor (30) and carry the flag,
  // but its ts is outside the Date range. Pre-fix: observe() threw
  // RangeError AFTER latching flagged=true - the flag was lost forever.
  const bad = det.observe({ type: 'detail', identity: members[2], ip: '10.0.0.1', ts: 1e16, recordIds: ids(400, 10) });
  assert.equal(bad.recorded, false);
  assert.equal(flags.length, 0);
  // The same event with a sane ts delivers the flag exactly once.
  const good = det.observe({ type: 'detail', identity: members[2], ip: '10.0.0.1', ts: T0 + 120_000, recordIds: ids(400, 10) });
  assert.equal(good.recorded, true);
  assert.equal(flags.length, 1, 'the flag is delivered by the good event - not lost');
  assert.equal(flags[0].combinedCoverage, 30);
});

test('F-21 action-cohort: out-of-range / non-finite ts is refused cleanly - no throw, no state', () => {
  const tracker = sdk.createActionCohortTracker({});
  for (const badTs of [1e16, -1e16, MAX_DATE_MS + 1, NaN, Infinity]) {
    const obs = tracker.observe({ subject: 'account:z', action: 'export', targetKey: 'slice:0', cost: 5, ts: badTs });
    assert.equal(obs.recorded, false, `ts=${String(badTs)} refused`);
  }
  assert.deepEqual(tracker.groups(), [], 'the refused events created no state');
  const edge = tracker.observe({ subject: 'account:z', action: 'export', targetKey: 'slice:0', cost: 5, ts: MAX_DATE_MS });
  assert.equal(edge.recorded, true, 'ts exactly at the Date maximum is valid');
});

test('F-21 action-cohort: the flag-carrying event with ts=1e16 wipes nothing - a good event still flags', () => {
  let clock = T0;
  const flags = [];
  const tracker = sdk.createActionCohortTracker({ onFlag: s => flags.push(s), now: () => clock });
  for (let i = 0; i < 7; i++) feedPair(tracker, `account:s${i}`, i * 2);
  assert.equal(flags.length, 0);
  // The 8th member's first event would complete the flag floors, but
  // carries ts=1e16. Pre-fix: the event was ACCEPTED and its window
  // prune wiped the whole export grouping state - the flag never
  // fired, even for later good events.
  const bad = tracker.observe({ subject: 'account:s7', action: 'export', targetKey: 'slice:14', cost: 8, ts: 1e16 });
  assert.equal(bad.recorded, false);
  assert.equal(flags.length, 0);
  clock += 1000;
  const good = tracker.observe({ subject: 'account:s7', action: 'export', targetKey: 'slice:14', cost: 8 });
  assert.equal(good.recorded, true);
  assert.equal(flags.length, 1, 'the pre-existing group survived and the good event completes the flag');
  assert.equal(flags[0].members.length, 8);
});
