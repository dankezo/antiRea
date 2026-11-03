const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Missing-mass signal (HARVEST2 candidate C22). These tests port the
// decisive cells of the study lab (C22-STEP0.md / C22-DESIGN.md /
// C22-RESULTS.md) to the SDK module:
//   - VALID day cells: lab FP 1/280 = 0.36% at alpha 0.02; here 14
//     fresh cells from the fitted generator must flag ~0;
//   - SALE day cells: lab 0/140 - sale sessions come from returning
//     identities, so f1 does not move;
//   - 1-hit herds: lab flagged 100% at H = 100/200/400 per day and
//     84.5% (day) / 100% (week) even at H = 50; here an H = 200 herd
//     cell must flag at both scales;
//   - EV-REUSE-2 is a REGISTERED BLIND SPOT, pinned below: a herd
//     that reuses every identity exactly twice contributes nothing
//     to f1 and must NOT flag (lab: 0/42). The PASS stands on the
//     pre-registered linked tax (reuse hands the herd to the
//     union / C6 / C10 channels); this module does not claim it.
//   - EV-REUSE-MIX (half 1-hit, half 3-touch) is still caught
//     (lab: 39/42 = 92.9%) - its 1-hit half still inflates f1.
// The cell generator is a simplified stand-in for the lab's
// harness-v2 population, calibrated to the lab's published cell
// levels: a legit day cell on the deep surface has n ~ 926 touches
// and m = f1/n ~ 0.082 (lab TRAIN p50 0.0839); a +200-singleton
// herd cell lands at m ~ 0.245 (lab herd p50 0.2554). Identities
// are persistent regulars plus a daily newcomer inflow; the week
// cells aggregate the same population over 7 days.
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

function poisson(rng, lambda) {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > l);
  return k - 1;
}

const REGULARS = 340;

// One legit day cell: persistent regulars (never exactly 1 touch)
// plus a Poisson newcomer inflow of one-hit identities.
function legitDayCell(rng, tag) {
  const touches = [];
  const regularIds = [];
  for (let i = 0; i < REGULARS; i++) {
    const id = `reg-${tag}-${i}`;
    regularIds.push(id);
    const count = 2 + poisson(rng, 0.5);
    for (let j = 0; j < count; j++) touches.push(id);
  }
  const newcomers = poisson(rng, 76);
  for (let i = 0; i < newcomers; i++) touches.push(`new-${tag}-${i}`);
  return { touches, regularIds };
}

// One legit week cell: the same population aggregated over 7 days
// (f1/n recomputed from the week's sums, as the lab registers).
function legitWeekCell(rng, tag) {
  const touches = [];
  for (let i = 0; i < REGULARS; i++) {
    const id = `reg-${tag}-${i}`;
    let count = 0;
    for (let d = 0; d < 7; d++) count += 2 + poisson(rng, 0.5);
    for (let j = 0; j < count; j++) touches.push(id);
  }
  for (let d = 0; d < 7; d++) {
    const newcomers = poisson(rng, 76);
    for (let i = 0; i < newcomers; i++) touches.push(`new-${tag}-${d}-${i}`);
  }
  return touches;
}

function addSingletons(touches, count, tag) {
  const out = [...touches];
  for (let i = 0; i < count; i++) out.push(`herd-${tag}-${i}`);
  return out;
}

const SURFACE_OF = (resourceId) => (resourceId >= 200 ? 'deep' : null);

function fittedInstance() {
  const inst = sdk.createMissingMassSignal({ surfaceOf: SURFACE_OF });
  const rng = mulberry32(20261102);
  const dayCells = [];
  for (let i = 0; i < 60; i++) dayCells.push(legitDayCell(rng, `train-${i}`).touches);
  const fitDay = inst.fitSurfaceCalibration('deep', 'day', dayCells);
  assert.equal(fitDay.fitted, true);
  assert.equal(fitDay.cells, 60);
  const weekCells = [];
  for (let i = 0; i < 24; i++) weekCells.push(legitWeekCell(rng, `trainw-${i}`));
  const fitWeek = inst.fitSurfaceCalibration('deep', 'week', weekCells);
  assert.equal(fitWeek.fitted, true);
  assert.equal(fitWeek.cells, 24);
  return inst;
}

// Score one synthetic cell by feeding it through a throwaway
// calibrated instance's observe path is overkill; instead the
// tests below drive cells through observe() on the fitted
// instance day by day. This helper feeds one full day of touches
// as events on day `dayIndex` and returns the closed day signal
// produced when the NEXT day's first event rolls the window.
function feedDay(inst, dayIndex, touches) {
  let closed = null;
  touches.forEach((identity, i) => {
    const obs = inst.observe({ identity, resourceId: 500, ts: dayIndex * 86400e3 + i * 1000 });
    for (const sig of obs.signals) if (sig.scale === 'day') closed = sig;
  });
  // Roll into the next day to close this day's cell.
  const roll = inst.observe({ identity: 'roll-marker', resourceId: 500, ts: (dayIndex + 1) * 86400e3 });
  for (const sig of roll.signals) if (sig.scale === 'day') closed = sig;
  return closed;
}

/* ---------------- hard condition 1: host surface map ---------------- */

test('no surface map: the module is disabled and scores nothing', () => {
  const inst = sdk.createMissingMassSignal();
  assert.equal(inst.enabled, false);
  const obs = inst.observe({ identity: 'a', resourceId: 500, ts: 0 });
  assert.equal(obs.status, 'disabled');
  assert.equal(obs.reason, 'surface_map_not_declared');
  assert.equal(obs.counted, false);
  const fit = inst.fitSurfaceCalibration('deep', 'day', [['a', 'b']]);
  assert.equal(fit.fitted, false);
  assert.equal(fit.status, 'disabled');
  const sig = inst.evaluateSurface('deep', 'day');
  assert.equal(sig.flagged, false);
  assert.equal(inst.snapshot().disabledReason, 'surface_map_not_declared');
});

test('events the host map places on no surface are never counted', () => {
  const inst = fittedInstance();
  const obs = inst.observe({ identity: 'hub-user', resourceId: 5, ts: 0 });
  assert.equal(obs.status, 'no_surface');
  assert.equal(obs.counted, false);
  assert.equal(inst.snapshot().counters.noSurface, 1);
});

/* ---------------- the lab's decisive cells (via fit + closed cells) ------- */

test('VALID day cells flag at the nominal rate, inside the lab bar (lab FP cell: 1/280 = 0.36%, bar 3.0%)', () => {
  // The flag rule is conformal at alpha = 0.02 BY DESIGN, so a
  // same-distribution cell flags ~2% of the time: the lab pooled
  // 280 cells to measure 0.36%, and its DESIGN replaced a flat
  // 2.0% FP bar with 3.0% precisely because a small cell pool
  // makes the raw rate a coin flip. This cell therefore pools 40
  // VALID days and asserts the registered bar, not zero: the one
  // deterministic flag (day 12, m = 0.1056 against a TRAIN max of
  // 0.1025, p = 1/61) is the nominal conformal event, verified by
  // hand against the reference pool - not a distribution shift
  // (the other 39 cells sit at p 0.15-0.98).
  const inst = fittedInstance();
  const rng = mulberry32(20261150);
  // Feed the 40 days continuously: each day is closed by the next
  // day's own first touch, so no synthetic event ever lands in a
  // measured cell. Day 39 is closed by one touch on day 40, whose
  // own cell is not measured.
  const closed = [];
  for (let d = 0; d < 40; d++) {
    const cell = legitDayCell(rng, `valid-${d}`);
    cell.touches.forEach((identity, i) => {
      const obs = inst.observe({ identity, resourceId: 500, ts: d * 86400e3 + i * 1000 });
      for (const sig of obs.signals) if (sig.scale === 'day') closed.push(sig);
    });
  }
  const last = inst.observe({ identity: 'closer', resourceId: 500, ts: 40 * 86400e3 });
  for (const sig of last.signals) if (sig.scale === 'day') closed.push(sig);
  assert.equal(closed.length, 40);
  let flagged = 0;
  for (const sig of closed) {
    assert.equal(sig.status, 'scored');
    assert.equal(sig.surface, 'deep');
    if (sig.flagged) flagged++;
  }
  assert.equal(flagged, 1, `expected exactly the 1 nominal flag, got ${flagged}`);
  assert.ok(flagged / 40 <= 0.03, 'pooled VALID FP stays inside the lab bar of 3.0%');
});

test('SALE day cells are not flagged (lab FP cell: 0/140)', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20261170);
  for (let d = 0; d < 5; d++) {
    const cell = legitDayCell(rng, `sale-${d}`);
    // Sale shape: extra touches from identities ALREADY present
    // (returning customers), never from new one-hit identities.
    const extra = [];
    for (let i = 0; i < 100; i++) {
      const id = cell.regularIds[i];
      extra.push(id, id, id);
    }
    const sig = feedDay(inst, d, [...cell.touches, ...extra]);
    assert.equal(sig.status, 'scored');
    assert.equal(sig.flagged, false, `sale day ${d} must not flag (m=${sig.missingMass})`);
  }
});

test('1-hit herd cells are flagged at day and week scales (lab teeth: 100% at H=200)', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20261190);
  // Day scale: one herd day (+200 one-hit identities).
  const herdDay = addSingletons(legitDayCell(rng, 'herd-day').touches, 200, 'day');
  const daySig = feedDay(inst, 0, herdDay);
  assert.equal(daySig.status, 'scored');
  assert.equal(daySig.flagged, true, `herd day must flag (m=${daySig.missingMass}, p=${daySig.pValue})`);
  assert.ok(daySig.pValue <= 0.02);

  // Week scale: seven herd days; the week cell closes when the
  // first event of week 2 arrives (feedDay's day-7 roll marker).
  const inst2 = fittedInstance();
  for (let d = 0; d < 7; d++) {
    const cell = addSingletons(legitDayCell(rng, `herd-week-${d}`).touches, 200, `w${d}`);
    feedDay(inst2, d, cell);
  }
  const weekSig = inst2.evaluateSurface('deep', 'week');
  assert.equal(weekSig.status, 'scored');
  assert.equal(weekSig.flagged, true, `herd week must flag (m=${weekSig.missingMass}, p=${weekSig.pValue})`);
  assert.ok(weekSig.pValue <= 0.05);
});

test('EV-REUSE-2 is NOT flagged (registered blind spot, pinned)', () => {
  // C22-DESIGN section 3 + C22-RESULTS: reuse contributes nothing
  // to f1, so a herd of 200 identities touching exactly twice is
  // structurally invisible to this statistic (lab 0/42). The cell
  // is asserted blind here so the blindness is a tested contract,
  // not an accident - and so nobody "fixes" it into a claim the
  // lab never measured.
  const inst = fittedInstance();
  const rng = mulberry32(20261196);
  const cell = legitDayCell(rng, 'reuse2');
  const touches = [...cell.touches];
  for (let i = 0; i < 200; i++) touches.push(`evr2-${i}`, `evr2-${i}`);
  const sig = feedDay(inst, 0, touches);
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, false, 'reuse-2 cell must stay unflagged by design');
  // And the mechanism is visible: f1 is the plain legit level
  // while n grew by the 400 reuse touches.
  assert.equal(sig.singletonIdentities, cell.touches.filter((v, i, a) => a.indexOf(v) === i && a.lastIndexOf(v) === i).length);
});

test('EV-REUSE-MIX is still flagged: its 1-hit half inflates f1 (lab: 39/42 = 92.9%)', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20261199);
  const cell = legitDayCell(rng, 'mix');
  const touches = [...cell.touches];
  for (let i = 0; i < 100; i++) touches.push(`mix1-${i}`);
  for (let i = 0; i < 100; i++) touches.push(`mix3-${i}`, `mix3-${i}`, `mix3-${i}`);
  const sig = feedDay(inst, 0, touches);
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, true, `mixed herd must flag (m=${sig.missingMass}, p=${sig.pValue})`);
});

test('EV-BURST: 1,400 one-hit identities in one day are flagged', () => {
  const inst = fittedInstance();
  const rng = mulberry32(20261202);
  const cell = addSingletons(legitDayCell(rng, 'burst').touches, 1400, 'burst');
  const sig = feedDay(inst, 0, cell);
  assert.equal(sig.status, 'scored');
  assert.equal(sig.flagged, true);
});

/* ---------------- floors, windows, calibration discipline ---------------- */

test('below-floor cells are counted but never scored (declared blind region)', () => {
  const inst = fittedInstance();
  const small = [];
  for (let i = 0; i < 100; i++) small.push(`tiny-${i}`); // n = 100 < 200 floor, all singletons
  const sig = feedDay(inst, 0, small);
  assert.equal(sig.status, 'below_floor');
  assert.equal(sig.flagged, false);
  assert.equal(sig.pValue, null);
  assert.equal(sig.events, 100);
  assert.equal(sig.missingMass, 1); // the statistic is extreme - and still not scored
});

test('uncalibrated surfaces report uncalibrated, never flag', () => {
  const inst = sdk.createMissingMassSignal({ surfaceOf: SURFACE_OF });
  const rng = mulberry32(5);
  const cell = addSingletons(legitDayCell(rng, 'raw').touches, 400, 'raw');
  const sig = feedDay(inst, 0, cell);
  assert.equal(sig.status, 'uncalibrated');
  assert.equal(sig.flagged, false);
  assert.equal(sig.pValue, null);
});

test('late events for a closed window are refused and never rewrite the cell', () => {
  const inst = fittedInstance();
  const rng = mulberry32(11);
  feedDay(inst, 0, legitDayCell(rng, 'late-0').touches);
  const before = inst.evaluateSurface('deep', 'day');
  const late = inst.observe({ identity: 'herd-late', resourceId: 500, ts: 3600e3 }); // day 0 again
  assert.equal(late.status, 'late_window');
  assert.equal(late.counted, false);
  const after = inst.evaluateSurface('deep', 'day');
  assert.deepEqual(after, before);
});

test('invalid timestamps are refused as no-ops', () => {
  const inst = fittedInstance();
  for (const ts of [NaN, Infinity, 8.64e15 + 1]) {
    const obs = inst.observe({ identity: 'a', resourceId: 500, ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
  }
  assert.equal(inst.snapshot().counters.invalidTs, 3);
});

test('fitting below the minimum cell floor throws a named error', () => {
  const inst = sdk.createMissingMassSignal({ surfaceOf: SURFACE_OF });
  const rng = mulberry32(3);
  const few = [];
  for (let i = 0; i < 5; i++) few.push(legitDayCell(rng, `few-${i}`).touches);
  assert.throws(
    () => inst.fitSurfaceCalibration('deep', 'day', few),
    (err) => err.name === 'MissingMassError',
  );
  assert.throws(
    () => inst.fitSurfaceCalibration('deep', 'day', [['only', 'three', 'touches']]),
    (err) => err.name === 'MissingMassError',
  );
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof sdk.createMissingMassSignal, 'function');
  const inst = fittedInstance();
  assert.equal(inst.snapshot().enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
