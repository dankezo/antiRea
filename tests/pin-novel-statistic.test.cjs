const { test } = require('node:test');
const assert = require('node:assert/strict');
// NOTE: this item ships the module file only; src/index.ts wiring is
// a separate integration step (and was explicitly out of scope), so
// the test imports the built module directly from its dist path -
// the shrink-slope test precedent.
const mod = require('../dist/tier2-active/pin-novel-statistic.js');
const {
  fitPinNovelStatistic,
  scorePinNovelStatistic,
  pinNovelExceeds,
  PinNovelStatisticError,
} = mod;

// ---------------------------------------------------------------------------
// FC-07 pin statistic (REGISTRATION-FC07-PIN-STRATUM-NOVEL.md, frozen
// 2026-11-16; FC07-RESULTS-2026-11-16.md, verdict PASS-LAB-WITH-COST).
// Novel-only per identity, per-stratum C-LAW fit, STRICT flag rule
// (novel > tau).
//
// These tests reproduce the frozen score table from the frozen
// fc01r-exposures.json (fit through 2026-11-11, score through
// 2026-11-15) EXACTLY - the same reproduction discipline FC-07's own
// sanity checks used. The fixture (tests/fixtures/
// fc01r-exposures.fixture.json) carries only the fields fc07.cjs
// consumes - identity, persona, nEventsFit, fit.novel, score.novel,
// score.total - for the FP strata (ordinary_reader, heavy_reader)
// and the detection strata (slow_attacker, review_team). The bulk
// shapes are the registration's synthetic gate set, not fixture rows.
//
// EVIDENCE STATE: the verdict rests on the calibration window only
// (calibration identities reused). HOLDOUT VALIDATION ON THE
// 16-22/11 TRACES IS PENDING (~23/11) and is NOT pre-answered by
// anything here. Cost: review_team crossing 100% > the 25% cost
// line. The strict rule's margin at the bound is exactly one record.
// ---------------------------------------------------------------------------

const fixture = require('./fixtures/fc01r-exposures.fixture.json');

const FP_STRATA = ['ordinary_reader', 'heavy_reader'];
const personaOf = new Map(fixture.map((r) => [r.identity, r.persona]));
// Host-declared strata resolver: a plain identity -> stratum map,
// exactly the declarations the farm table carries.
const resolver = Object.fromEntries(fixture.map((r) => [r.identity, r.persona]));

const fitExposures = fixture.map((r) => ({
  identity: r.identity,
  stratum: r.persona,
  novelFit: r.fit.novel,
  nEventsFit: r.nEventsFit,
}));
const scoreExposures = fixture.map((r) => ({ identity: r.identity, novel: r.score.novel }));

const fit = fitPinNovelStatistic(fitExposures, { referenceStrata: FP_STRATA });
const decisions = scorePinNovelStatistic(fit, scoreExposures, resolver);
const flaggedByPersona = (persona) =>
  decisions.filter((d) => personaOf.get(d.identity) === persona && d.flagged).length;
const countByPersona = (persona) => fixture.filter((r) => r.persona === persona).length;

// FC-01R farm-native bulk gate set, verbatim: novel = rate x 14,
// total = 2 x rate x 14, rates 100/200/300/400.
const gateShapes = [100, 200, 300, 400].map((rate) => ({
  identity: `shape:${rate}/day`,
  novel: rate * 14,
  total: 2 * rate * 14,
}));

test('fc07 fit: mixture weights recomputed from the table match FC-01R choice-(d) figures', () => {
  assert.equal(fit.fitIdentities, 54);
  assert.equal(fit.fitEventsByStratum.ordinary_reader, 24743);
  assert.equal(fit.fitEventsByStratum.heavy_reader, 14273);
  assert.equal(fit.fitEventsTotal, 39016);
  assert.equal(fit.flagRule, 'novel > tau (STRICT)');
});

test('fc07 fit: tau_pooled = 500 (weighted nearest-rank q95; unweighted diagnostic also 500)', () => {
  assert.equal(fit.tauPooled, 500);
  assert.equal(fit.tauPooledUnweightedDiagnostic, 500);
});

test('fc07 fit: ordinary_reader tau_S = 500 FITTED (n=36 >= 20, Q99.5 = 108, pooled bound dominates)', () => {
  const s = fit.strata.ordinary_reader;
  assert.equal(s.nFit, 36);
  assert.equal(s.fallback, false);
  assert.equal(s.qLevel, 0.995);
  assert.equal(s.qS, 108);
  assert.equal(s.tauS, 500);
});

test('fc07 fit: heavy_reader tau_S = 500 BY FALLBACK (n=18 < 20, fallback path reported)', () => {
  const s = fit.strata.heavy_reader;
  assert.equal(s.nFit, 18);
  assert.equal(s.fallback, true);
  assert.equal(s.qLevel, 0.98);
  // For the record (FC07-RESULTS): heavy's unused Q98 also computes
  // to 500 - the fallback changes no number, but the path is fallback.
  assert.equal(s.qS, 500);
  assert.equal(s.tauS, 500);
  assert.equal(s.tauS, fit.tauPooled);
});

test('fc07 score: FP strata 0 flagged - ordinary 0/36, heavy 0/18 (the strict rule dissolves the mass point)', () => {
  assert.equal(countByPersona('ordinary_reader'), 36);
  assert.equal(countByPersona('heavy_reader'), 18);
  assert.equal(flaggedByPersona('ordinary_reader'), 0);
  assert.equal(flaggedByPersona('heavy_reader'), 0);
  // Every heavy score novel sits exactly ON the bound: 500 > 500 is false.
  const heavy = decisions.filter((d) => personaOf.get(d.identity) === 'heavy_reader');
  assert.ok(heavy.every((d) => d.novel === 500 && d.tauApplied === 500 && d.tauSource === 'stratum'));
});

test('fc07 score: detection strata under tau_pooled - slow_attacker 2/2, review_team 14/14 (the WITH-COST cell)', () => {
  assert.equal(countByPersona('slow_attacker'), 2);
  assert.equal(countByPersona('review_team'), 14);
  assert.equal(flaggedByPersona('slow_attacker'), 2);
  assert.equal(flaggedByPersona('review_team'), 14);
  const det = decisions.filter((d) => ['slow_attacker', 'review_team'].includes(personaOf.get(d.identity)));
  assert.ok(det.every((d) => d.tauApplied === fit.tauPooled && d.tauSource === 'pooled'));
});

test('fc07 shapes: bulk shapes cross 4/4 under tau_pooled (novels 1400/2800/4200/5600)', () => {
  assert.deepEqual(gateShapes.map((s) => s.novel), [1400, 2800, 4200, 5600]);
  // Shapes are undeclared identities: no resolver entry, pooled bound.
  const shapeDecisions = scorePinNovelStatistic(fit, gateShapes, resolver);
  assert.equal(shapeDecisions.filter((d) => d.flagged).length, 4);
  assert.ok(shapeDecisions.every((d) => d.stratum === null && d.tauSource === 'pooled' && d.tauApplied === 500));
});

// ---- comparators, scored from the frozen table exactly as fc07.cjs ----
// (novel, total) pair rule: novel >= pair.novel AND total >= pair.total.
const flagPair = (pair) => (e) => e.novel >= pair.novel && e.total >= pair.total;
const pairCount = (pair, persona) =>
  fixture.filter((r) => r.persona === persona && flagPair(pair)(r.score)).length;
const pairShapeCount = (pair) => gateShapes.filter((s) => flagPair(pair)(s)).length;

test('fc07 comparator: farm pair (500, 37258) reproduces exactly - heavy 4/18, shapes 0/4', () => {
  const farmPair = { novel: 500, total: 37258 };
  assert.equal(pairCount(farmPair, 'heavy_reader'), 4);
  assert.equal(pairShapeCount(farmPair), 0);
  // Remaining published farm-pair cells, for exactness:
  assert.equal(pairCount(farmPair, 'ordinary_reader'), 0);
  assert.equal(pairCount(farmPair, 'slow_attacker'), 0);
  assert.equal(pairCount(farmPair, 'review_team'), 14);
});

test('fc07 comparator: lab pair (1508, 2522) reproduces exactly - slow 2/2, review 9/14, shapes 3/4', () => {
  const labPair = { novel: 1508, total: 2522 };
  assert.equal(pairCount(labPair, 'slow_attacker'), 2);
  assert.equal(pairCount(labPair, 'review_team'), 9);
  assert.equal(pairShapeCount(labPair), 3);
  assert.equal(pairCount(labPair, 'ordinary_reader'), 0);
  assert.equal(pairCount(labPair, 'heavy_reader'), 0);
});

test('fc07 comparator: FC-06 Arm N (tau 500, >= rule) reproduces exactly - heavy 18/18', () => {
  // fc07.cjs's Arm N form: novel > 0 AND novel >= tauPooled.
  const flagArmN = (e) => e.novel > 0 && e.novel >= fit.tauPooled;
  assert.equal(fixture.filter((r) => r.persona === 'heavy_reader' && flagArmN(r.score)).length, 18);
  assert.equal(fixture.filter((r) => r.persona === 'ordinary_reader' && flagArmN(r.score)).length, 0);
  assert.equal(fixture.filter((r) => r.persona === 'slow_attacker' && flagArmN(r.score)).length, 2);
  assert.equal(fixture.filter((r) => r.persona === 'review_team' && flagArmN(r.score)).length, 14);
  assert.equal(gateShapes.filter((s) => flagArmN(s)).length, 4);
});

test('fc07 strictness: novel == tau does NOT flag, novel == tau + 1 flags (margin at the bound is one record)', () => {
  assert.equal(pinNovelExceeds(500, 500), false);
  assert.equal(pinNovelExceeds(501, 500), true);
  const atBound = scorePinNovelStatistic(fit, [{ identity: 'undeclared:at-bound', novel: fit.tauPooled }], resolver);
  assert.equal(atBound[0].flagged, false);
  assert.equal(atBound[0].tauApplied, 500);
  const aboveBound = scorePinNovelStatistic(
    fit,
    [{ identity: 'undeclared:above-bound', novel: fit.tauPooled + 1 }],
    resolver,
  );
  assert.equal(aboveBound[0].flagged, true);
});

test('fc07 strata: host declaration only - undeclared identities score under tau_pooled, declared FP strata under tau_S', () => {
  const [declared] = scorePinNovelStatistic(fit, [{ identity: fixture[0].identity, novel: 501 }], resolver);
  assert.equal(declared.tauSource, 'stratum');
  assert.equal(declared.stratum, personaOf.get(fixture[0].identity));
  // A resolver callback form resolves identically to the map form.
  const [viaCallback] = scorePinNovelStatistic(
    fit,
    [{ identity: fixture[0].identity, novel: 501 }],
    (id) => personaOf.get(id),
  );
  assert.deepEqual(viaCallback, declared);
  // No resolver at all: every identity is undeclared -> pooled.
  const [undeclared] = scorePinNovelStatistic(fit, [{ identity: fixture[0].identity, novel: 501 }]);
  assert.equal(undeclared.stratum, null);
  assert.equal(undeclared.tauSource, 'pooled');
  assert.equal(undeclared.tauApplied, fit.tauPooled);
});

test('fc07 validation: malformed fit/score inputs are refused with PinNovelStatisticError', () => {
  assert.throws(() => fitPinNovelStatistic([]), PinNovelStatisticError);
  assert.throws(
    () => fitPinNovelStatistic([{ identity: 'x', stratum: 'ordinary_reader', novelFit: -1, nEventsFit: 1 }]),
    PinNovelStatisticError,
  );
  assert.throws(
    () => fitPinNovelStatistic(fitExposures, { referenceStrata: ['no_such_stratum'] }),
    PinNovelStatisticError,
  );
  assert.throws(() => scorePinNovelStatistic(fit, [{ identity: 'x', novel: Number.NaN }]), PinNovelStatisticError);
});
