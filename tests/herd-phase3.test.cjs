const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/**
 * Phase-3 herd evidence (2.5.0): leader-based coverage-complement
 * grouping and supplementary re-announcement for flagged groups.
 * Scaled configuration mirrors tests/herd-detector.test.cjs (1,000-
 * record scale: combined floor 30, ramp 400, cap 200, union floor
 * 30, min-own 5); the materiality floor derives as ceil(30/12) = 3.
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

test('leader grouping: a dispersed 8-identity herd forms ONE v2 group and flags (no v1 chaining)', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s), recheckGrowth: 5 }));
  const members = Array.from({ length: 8 }, (_, i) => `account:lead${i}`);
  // Signups 18 days apart on distinct IPs: v1 can never group them.
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 18 * DAY, undefined, `10.0.1.${i}`));
  let t = T0 + 130 * DAY;
  // Round-robin disjoint contiguous slices, 10 records per turn.
  const pos = members.map(() => 0);
  for (let round = 0; round < 12; round++) {
    members.forEach((m, i) => {
      feed(det, 'detail', m, t, ids(i * 120 + pos[i], 10), `10.0.1.${i}`);
      pos[i] += 10;
      t += 10_000;
    });
  }
  const v2 = det.groups().filter(g => g.mechanism === 'v2-coverage');
  assert.equal(v2.length, 1, `expected exactly one v2 group, got ${v2.length}`);
  assert.equal(v2[0].members.length, 8, 'all 8 dispersed identities merged into the leader group');
  assert.equal(v2[0].combinedCoverage, 960);
  assert.ok(flags.length >= 1, 'the leader group flagged');
  assert.equal(flags[0].mechanism, 'v2-coverage');
});

test('leader grouping scale: 300 dispersed identities merge into one group; 200 identical readers never merge', () => {
  const det = sdk.createHerdDetector(scaled({ recheckGrowth: 5 }));
  const N = 300;
  let t = T0;
  for (let i = 0; i < N; i++) feed(det, 'signup', `account:s${i}`, T0 + i * DAY, undefined, `10.1.${i % 250}.${Math.floor(i / 250)}`);
  t = T0 + 310 * DAY;
  for (let served = 0; served < 60; served += 10) {
    for (let i = 0; i < N; i++) {
      feed(det, 'detail', `account:s${i}`, t, ids(i * 60 + served, 10), `10.1.${i % 250}.${Math.floor(i / 250)}`);
      t += 100;
    }
  }
  const v2 = det.groups().filter(g => g.mechanism === 'v2-coverage' && g.members.length > 1);
  assert.equal(v2.length, 1, `expected one merged v2 group, got ${v2.length}`);
  assert.equal(v2[0].members.length, N);

  // Legit worst case for candidate enumeration: 200 readers with
  // IDENTICAL sets (Jaccard 1) - complementarity must never link them.
  const det2 = sdk.createHerdDetector(scaled({ recheckGrowth: 5 }));
  let t2 = T0;
  for (let i = 0; i < 200; i++) feed(det2, 'signup', `account:r${i}`, T0 + i * DAY, undefined, `10.2.${i % 250}.${Math.floor(i / 250)}`);
  t2 = T0 + 210 * DAY;
  for (let served = 0; served < 60; served += 10) {
    for (let i = 0; i < 200; i++) {
      feed(det2, 'detail', `account:r${i}`, t2, ids(served, 10), `10.2.${i % 250}.${Math.floor(i / 250)}`);
      t2 += 100;
    }
  }
  const linked = det2.groups().filter(g => g.mechanism === 'v2-coverage' && g.members.length > 1);
  assert.equal(linked.length, 0, 'identical readers never link under complement grouping');
});

test('supplementary: late joiners of a flagged v1 group are re-announced; a duplicating bystander is not', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const first = [0, 1, 2].map(i => `account:early${i}`);
  first.forEach((m, i) => feed(det, 'signup', m, T0 + i * 20_000));
  let t = T0 + 120_000;
  // Disjoint chunks round-robin until the v1 flag fires (combined 30).
  for (let round = 0; round < 2 && flags.length === 0; round++) {
    first.forEach((m, i) => { feed(det, 'detail', m, t, ids(i * 200 + round * 10, 10)); t += 10_000; });
  }
  assert.equal(flags.length, 1, 'initial flag fired');
  assert.equal(flags[0].supplementary, undefined, 'the initial flag is not marked supplementary');
  assert.deepEqual([...flags[0].members].sort(), [...first].sort());

  // Two late joiners sign up (still inside the chaining window) and
  // start serving disjoint slices of the same dataset.
  const late = [3, 4].map(i => `account:late${i}`);
  late.forEach((m, i) => feed(det, 'signup', m, t + i * 20_000));
  t += 60_000;
  late.forEach((m, i) => { feed(det, 'detail', m, t, ids(600 + i * 100, 10)); t += 10_000; });
  const supplementary = flags.filter(f => f.supplementary === true);
  assert.ok(supplementary.length >= 1, 'a supplementary flag re-announced the flagged group');
  const announcedMembers = new Set(flags.flatMap(f => f.members));
  for (const m of [...first, ...late]) assert.ok(announcedMembers.has(m), `${m} was announced`);
  const supp = supplementary[supplementary.length - 1];
  assert.ok((supp.memberUniqueCoverage['account:late3'] ?? 0) >= 3, 'late joiner announced with material unique coverage');

  // A bystander who joins the same group but only re-reads records
  // the herd already served (unique coverage 0) triggers nothing.
  const flagCountBefore = flags.length;
  feed(det, 'signup', 'account:bystander', t);
  t += 10_000;
  feed(det, 'detail', 'account:bystander', t, ids(0, 10));
  assert.equal(flags.length, flagCountBefore, 'a duplicating bystander triggers no supplementary flag');
});

test('supplementary: pending partial contributors (announced below the floor) are re-announced at the floor', () => {
  const flags = [];
  // Materiality floor pinned high (25) against the scaled flag floor
  // (30): the group flags when each member has only 5 unique records
  // - the ID-walk shape whose first flag targeted nobody.
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s), lateJoinerMinUniqueRecords: 25 }));
  const members = Array.from({ length: 6 }, (_, i) => `account:walk${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 20_000));
  let t = T0 + 120_000;
  members.forEach((m, i) => { feed(det, 'detail', m, t, ids(i * 200, 5)); t += 10_000; });
  assert.equal(flags.length, 1, 'initial flag fired at combined 30');
  assert.ok(flags[0].memberUniqueCoverage['account:walk0'] < 25, 'members were below the materiality floor at flag time');
  // One walker keeps walking its disjoint range past the floor.
  for (let p = 5; p < 30; p += 5) { feed(det, 'detail', 'account:walk0', t, ids(p, 5)); t += 10_000; }
  assert.equal(flags.length, 2, `expected exactly one supplementary flag, got ${flags.length}`);
  assert.equal(flags[1].supplementary, true);
  assert.ok(flags[1].memberUniqueCoverage['account:walk0'] >= 25, 'the pending walker was re-announced at material coverage');
});

test('supplementary: members announced at zero unique coverage never re-trigger (once-per-window discipline)', () => {
  const flags = [];
  const det = sdk.createHerdDetector(scaled({ onFlag: s => flags.push(s) }));
  const members = Array.from({ length: 6 }, (_, i) => `account:herd${i}`);
  members.forEach((m, i) => feed(det, 'signup', m, T0 + i * 20_000));
  let t = T0 + 180_000;
  // Only the first three members serve before the flag (combined 30);
  // the other three are group members announced at unique 0.
  [0, 1, 2].forEach(i => { feed(det, 'detail', members[i], t, ids(i * 200, 10)); t += 10_000; });
  assert.equal(flags.length, 1, 'initial flag fired with all 6 members in the snapshot');
  // The dormant members now serve heavily, disjoint. Because they
  // were named in the initial snapshot at unique 0, no supplementary
  // flag fires for them - this is the asserted contract, not a miss.
  [3, 4, 5].forEach(i => { feed(det, 'detail', members[i], t, ids(i * 200, 40)); t += 10_000; });
  assert.equal(flags.length, 1, `expected no supplementary flag, got ${flags.length}`);
});


test("supplementary coalescing: a burst of crossings yields ONE supplementary after the cooldown, not one per member", () => {
  const flags = [];
  const herd = sdk.createHerdDetector({
    recordIndex: (id) => Number(id.slice(4)) - 1001,
    // shipped defaults for floor/threshold/cooldown (5s)
    onFlag: (snap) => flags.push(snap),
  });
  const base = Date.UTC(2026, 0, 1);
  const members = Array.from({ length: 18 }, (_, i) => `burst${i}`);
  for (const m of members) {
    herd.observe({ type: "signup", identity: m, ip: "203.0.113.9", ts: base });
  }
  // Disjoint segments, round-robin bursts - the ID-walk shape: the
  // group flags with every member still below the materiality floor
  // (17 unique each), then all 18 cross 25 within milliseconds.
  let t = base;
  const pos = new Array(18).fill(0);
  const serve = (i) => {
    t += 2;
    herd.observe({
      type: "detail", identity: members[i], ip: "203.0.113.9",
      recordIds: [`ACC-${1001 + i * 555 + pos[i]++}`], ts: t,
    });
  };
  for (let step = 0; step < 18 * 30; step++) serve(step % 18);
  assert.equal(flags.length, 1, "only the initial flag during/immediately after the burst");
  assert.equal(flags[0].supplementary, undefined);
  // One more event after the cooldown: the whole burst is announced
  // together in a single supplementary flag.
  t += 6_000;
  herd.observe({
    type: "detail", identity: members[0], ip: "203.0.113.9",
    recordIds: [`ACC-${1001 + pos[0]++}`], ts: t,
  });
  assert.equal(flags.length, 2, "exactly one coalesced supplementary");
  assert.equal(flags[1].supplementary, true);
  assert.equal(flags[1].members.length, 18);
});
