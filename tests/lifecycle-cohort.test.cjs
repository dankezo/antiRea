const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Lifecycle cohort signal (HARVEST2 candidate C23). These tests port
// the decisive cells of the study lab (C23-STEP0.md / C23-DESIGN.md /
// C23-RESULTS.md) to the SDK module:
//   - LAUNCH cohorts (a legitimate launch pulling dormant users
//     back en masse, WITH a synchronized staging touch on launch
//     morning): lab FP 0/60 - the conjunction's burst and funnel
//     terms are what a legit return does not carry;
//   - VALID / SALE cohorts: lab FP 0/100 and 0/50;
//   - BUST cohorts (aged, dormant, synchronized staging, 320-novel
//     burst concentrated in one funnel): lab teeth 18/18;
//   - the identity feature is DESCRIPTIVE ONLY by a law locked in
//     the lab before its re-check: the re-check measured FP 2.9% >
//     the 2% bar (58/2,000 legitimate returners land in the
//     rho >= 0.5 and nu >= 4 region), so evaluateIdentity returns
//     scores and NO flag field exists - pinned below;
//   - EV-DESYNC at 4-6 days is a MEASURED BLIND SPOT (lab: staging
//     1-3 days early caught 36/51; 4-6 days early 0/45 - the early
//     staging touch becomes its own harmless return point and the
//     burst day loses its return anchor), and EV-SLOW (burst
//     spread so nu ~ 1.5) is invisible by construction (lab
//     0/300). Both are pinned as designed behavior.
// Constructions mirror the lab's: a 14-day legit history phase, a
// shared dormancy, a return. Topics: topicOf(id) = floor(id/300);
// the staging band is ids 1900..1999 (the lab's rarest-band proxy).
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3600e3;
const DAY = 86400e3;

const TOPIC_OF = (id) => Math.floor(id / 300);
const IS_STAGING = (id) => id >= 1900 && id <= 1999;

function declaredInstance(extra = {}) {
  return sdk.createLifecycleCohortSignal({ isStagingResource: IS_STAGING, topicOf: TOPIC_OF, ...extra });
}

// 14 days of ordinary history: 42 events, every one novel.
function historyEvents(m, rng) {
  const events = [];
  let counter = 0;
  for (let d = 0; d < 14; d++) {
    for (let i = 0; i < 3; i++) {
      events.push({
        ts: d * DAY + (8 + Math.floor(rng() * 10)) * HOUR + counter * 97e3,
        resourceId: (m * 61 + counter) % 1800,
      });
      counter++;
    }
  }
  return events;
}

function historyIdSet(m) {
  const set = new Set();
  for (let c = 0; c < 42; c++) set.add((m * 61 + c) % 1800);
  return set;
}

// A legitimate 7-day return phase (novel output stays modest).
function returnEvents(m, rng, startDay) {
  const events = [];
  let counter = 100;
  for (let d = 0; d < 7; d++) {
    for (let i = 0; i < 3; i++) {
      events.push({
        ts: (startDay + d) * DAY + (8 + Math.floor(rng() * 10)) * HOUR + counter * 97e3,
        resourceId: (m * 61 + counter) % 1800,
      });
      counter++;
    }
  }
  return events;
}

// The bust burst: 320 novel events inside ~70h, 200 of them in
// topic 0 (share 0.625 of the window), optionally with a staging
// touch offset from the burst start.
function burstEvents(m, j, startMs, { stagingOffsetMs = 0, withStaging = true } = {}) {
  const events = [];
  if (withStaging) {
    events.push({ ts: startMs + stagingOffsetMs + j * 300e3, resourceId: 1900 + (j % 100) });
  }
  const hist = historyIdSet(m);
  const topic0 = [];
  const rest = [];
  for (let id = 0; id < 300; id++) if (!hist.has(id)) topic0.push(id);
  for (let id = 300; id < 1800; id++) if (!hist.has(id)) rest.push(id);
  const picks = [...topic0.slice(0, 200), ...rest.slice(0, 120)];
  picks.forEach((rid, t) => events.push({ ts: startMs + t * 780e3, resourceId: rid }));
  return events;
}

// The slow burst: ~65 novel spread over 14 days (nu ~ 1.5 by
// construction - the lab's EV-SLOW), 60% in topic 0, with staging.
function slowBurstEvents(m, j, startMs) {
  const events = [{ ts: startMs + j * 300e3, resourceId: 1900 + (j % 100) }];
  const hist = historyIdSet(m);
  const topic0 = [];
  const rest = [];
  for (let id = 0; id < 300; id++) if (!hist.has(id)) topic0.push(id);
  for (let id = 300; id < 1800; id++) if (!hist.has(id)) rest.push(id);
  const picks = [...topic0.slice(0, 39), ...rest.slice(0, 26)];
  const step = (14 * DAY) / picks.length;
  picks.forEach((rid, t) => events.push({ ts: startMs + Math.floor(t * step), resourceId: rid }));
  return events;
}

function feedMember(inst, identity, events, cohortId) {
  for (const e of events) inst.observe({ identity, cohortId, ...e });
}

function buildCohort(inst, cohortId, memberEvents) {
  memberEvents.forEach((events, m) => feedMember(inst, `${cohortId}-member-${m}`, events, cohortId));
}

/* ---------------- the lab's decisive cells ---------------- */

test('BUST cohort is flagged: aged, dormant, staged, funnel burst, synchronized (lab teeth: 18/18)', () => {
  const inst = declaredInstance();
  const R = 14 + 60; // shared dormancy of 60 days
  const members = [];
  for (let m = 0; m < 24; m++) {
    const rng = mulberry32(5000 + m);
    members.push([...historyEvents(m, rng), ...burstEvents(m, m, R * DAY)]);
  }
  buildCohort(inst, 'bust', members);
  const sig = inst.evaluateCohort('bust');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, true);
  assert.equal(sig.maxFiringMembers, 24);
  assert.equal(sig.firingDayIndex, R);
  assert.equal(sig.firingMembers.length, 24);
  assert.equal(sig.enforcement, 'none');
});

test('LAUNCH cohort is NOT flagged: legit mass return with morning staging (lab FP: 0/60)', () => {
  // The C18/C20 killer cell in C23's form: every member returns
  // the same day AND touches the staging band that morning - but
  // a legit return has no burst (nu ~ 1) and no funnel, so the
  // conjunction does not fire.
  const inst = declaredInstance();
  const R = 14 + 45;
  const members = [];
  for (let m = 0; m < 24; m++) {
    const rng = mulberry32(6000 + m);
    const staging = { ts: R * DAY + m * 300e3, resourceId: 1900 + (m % 100) };
    members.push([...historyEvents(m, rng), staging, ...returnEvents(m, rng, R)]);
  }
  buildCohort(inst, 'launch', members);
  const sig = inst.evaluateCohort('launch');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, false);
  assert.equal(sig.maxFiringMembers, 0);
  assert.equal(sig.membersWithReturnPoints, 24);
});

test('a cohort of plain active identities (no dormancy) is not flagged', () => {
  const inst = declaredInstance();
  const members = [];
  for (let m = 0; m < 24; m++) members.push(historyEvents(m, mulberry32(7000 + m)));
  buildCohort(inst, 'plain', members);
  const sig = inst.evaluateCohort('plain');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, false);
  assert.equal(sig.membersWithReturnPoints, 0);
});

test('fewer firing members than the threshold does not flag (synchrony is the gate)', () => {
  const inst = declaredInstance();
  const R = 14 + 60;
  const members = [];
  for (let m = 0; m < 5; m++) {
    const rng = mulberry32(8000 + m);
    members.push([...historyEvents(m, rng), ...burstEvents(m, m, R * DAY)]);
  }
  buildCohort(inst, 'small-bust', members);
  const sig = inst.evaluateCohort('small-bust');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.maxFiringMembers, 5);
  assert.equal(sig.flagged, false, '5 firing members < the 6 threshold must not flag');
});

/* ---------------- identity feature: descriptive only ---------------- */

test('identity scores are descriptive: region hits are reported, no flag field exists', () => {
  // The lab demotion, implemented as an API contract: a solo
  // bust DOES land in the region (lab BUST-SOLO: 300/300 in
  // region, single-fire rule met) - and the module still returns
  // scores only, because the same region holds 2.9% of legit
  // returners.
  const inst = declaredInstance();
  const R = 14 + 60;
  const rng = mulberry32(9000);
  feedMember(inst, 'solo-bust', [...historyEvents(0, rng), ...burstEvents(0, 0, R * DAY)]);
  const scores = inst.evaluateIdentity('solo-bust');
  assert.equal(scores.status, 'scored');
  assert.ok(scores.regionHits >= 1, 'the bust return point lands in the descriptive region');
  const point = scores.returnPoints.find((p) => p.inRegion);
  assert.ok(point, 'a return point is in the region');
  assert.ok(point.dormancyRatio >= 0.5);
  assert.ok(point.burstVelocity >= 4);
  assert.equal(point.fires, true, 'the conjunction components are reported descriptively');
  // The demotion contract: no verdict-shaped field anywhere.
  assert.equal('flagged' in scores, false);
  assert.equal('verdict' in scores, false);
  assert.equal('decision' in scores, false);
  assert.equal(scores.enforcement, 'none');
  assert.match(scores.notice, /[Dd]escriptive/);
});

test('legit returner scores: modest nu keeps the return point out of the region', () => {
  const inst = declaredInstance();
  const R = 14 + 45;
  const rng = mulberry32(9100);
  const staging = { ts: R * DAY + 300e3, resourceId: 1901 };
  feedMember(inst, 'returner', [...historyEvents(1, rng), staging, ...returnEvents(1, rng, R)]);
  const scores = inst.evaluateIdentity('returner');
  assert.equal(scores.status, 'scored');
  assert.equal(scores.regionHits, 0);
  const point = scores.returnPoints[0];
  assert.ok(point, 'the return after 45 dormant days is a return point');
  assert.equal(point.stagingPresent, true, 'the morning staging touch is seen');
  assert.ok(point.burstVelocity < 4, `legit return nu (${point.burstVelocity}) stays under the burst line`);
  assert.equal(point.fires, false);
});

/* ---------------- measured blind spots, pinned ---------------- */

test('EV-DESYNC: staging 5 days before the burst is NOT flagged (measured blind spot)', () => {
  // C23-RESULTS: desync of 4-6 days is fully blind (0/45) - the
  // early staging touch becomes its own harmless return point
  // and the burst start, only 5 days later, is no return point
  // at all. Pinned so the blindness is a tested contract.
  const inst = declaredInstance();
  const R = 14 + 60;
  const members = [];
  for (let m = 0; m < 24; m++) {
    const rng = mulberry32(10000 + m);
    members.push([...historyEvents(m, rng), ...burstEvents(m, m, R * DAY, { stagingOffsetMs: -5 * DAY })]);
  }
  buildCohort(inst, 'desync', members);
  const sig = inst.evaluateCohort('desync');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, false, 'desync 5d must stay blind by design');
  assert.equal(sig.maxFiringMembers, 0);
});

test('EV-SLOW: a burst spread over 14 days (nu ~ 1.5) does not fire', () => {
  // Registered as budget/CUSUM ground in the lab (0/300): the
  // funnel and staging terms hold, the burst term does not.
  const inst = declaredInstance();
  const R = 14 + 60;
  const rng = mulberry32(11000);
  feedMember(inst, 'slow-0', [...historyEvents(0, rng), ...slowBurstEvents(0, 0, R * DAY)]);
  const scores = inst.evaluateIdentity('slow-0');
  const point = scores.returnPoints.find((p) => p.stagingPresent);
  assert.ok(point, 'the return point is found');
  assert.ok(point.burstVelocity < 4, `slow burst nu (${point.burstVelocity}) stays under the burst line`);
  assert.equal(point.fires, false);
  assert.equal(scores.regionHits, 0);
});

/* ---------------- declarations and discipline ---------------- */

test('without the staging band or the topic map the cohort channel is off', () => {
  const noTopic = sdk.createLifecycleCohortSignal({ isStagingResource: IS_STAGING });
  const noStaging = sdk.createLifecycleCohortSignal({ topicOf: TOPIC_OF });
  const neither = sdk.createLifecycleCohortSignal();
  for (const [name, inst] of [['noTopic', noTopic], ['noStaging', noStaging], ['neither', neither]]) {
    const R = 14 + 60;
    const rng = mulberry32(12000);
    feedMember(inst, 'm0', [...historyEvents(0, rng), ...burstEvents(0, 0, R * DAY)], 'c');
    const sig = inst.evaluateCohort('c');
    assert.equal(sig.status, 'undeclared', `${name} must report undeclared`);
    assert.equal(sig.flagged, false);
    assert.equal(inst.snapshot().cohortChannelEnabled, false);
    // Identity scores (rho/nu) remain available without declarations.
    const scores = inst.evaluateIdentity('m0');
    assert.equal(scores.status, 'scored');
    assert.ok(scores.returnPoints.length >= 1);
  }
  // Each missing declaration nulls exactly its own term - the
  // other term is still computed from its declaration:
  const noTopicPoint = noTopic.evaluateIdentity('m0').returnPoints[0];
  assert.equal(noTopicPoint.funnelShare, null, 'no topic map: funnel is null, not invented');
  assert.equal(noTopicPoint.stagingPresent, true, 'staging band declared: staging still read');
  const noStagingPoint = noStaging.evaluateIdentity('m0').returnPoints[0];
  assert.equal(noStagingPoint.stagingPresent, null, 'no staging band: staging is null, not invented');
  assert.ok(noStagingPoint.funnelShare !== null, 'topic map declared: funnel still computed');
  const neitherPoint = neither.evaluateIdentity('m0').returnPoints[0];
  assert.equal(neitherPoint.stagingPresent, null);
  assert.equal(neitherPoint.funnelShare, null);
  assert.equal(neitherPoint.fires, false, 'with a term undeclared the conjunction can never fire');
});

test('invalid timestamps are refused as no-ops; unknown identities score as unknown', () => {
  const inst = declaredInstance();
  for (const ts of [NaN, Infinity, 8.64e15 + 1]) {
    const obs = inst.observe({ identity: 'a', resourceId: 1, ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
  }
  assert.equal(inst.snapshot().counters.invalidTs, 3);
  const scores = inst.evaluateIdentity('ghost');
  assert.equal(scores.status, 'unknown');
  assert.equal(scores.returnPoints.length, 0);
});

test('malformed options and events throw named errors', () => {
  for (const opts of [{ returnGapMs: 0 }, { dormancyRatioMin: 0 }, { funnelShareMin: 1.5 }, { minFiringMembers: 0 }]) {
    assert.throws(
      () => sdk.createLifecycleCohortSignal(opts),
      (err) => err.name === 'LifecycleCohortError',
      `expected LifecycleCohortError for ${JSON.stringify(opts)}`,
    );
  }
  const inst = declaredInstance();
  assert.throws(
    () => inst.observe({ identity: 'a', resourceId: null, ts: 0 }),
    (err) => err.name === 'LifecycleCohortError',
  );
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof sdk.createLifecycleCohortSignal, 'function');
  const inst = declaredInstance();
  assert.equal(inst.snapshot().enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
