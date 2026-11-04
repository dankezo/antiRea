const { test } = require('node:test');
const assert = require('node:assert/strict');
// This phase does not touch src/index.ts (the integrator wires the
// export); prefer the package root when it is present and fall back
// to the compiled module itself.
let sdk;
try {
  sdk = require('../dist/index.js');
  if (typeof sdk.createValueWatermark !== 'function') throw new Error('not exported yet');
} catch {
  sdk = require('../dist/tier2-active/value-watermark.js');
}

// ---------------------------------------------------------------------------
// Value watermark (HARVEST2 candidate C39, SUPREME configuration).
// These tests port the decisive cells of the study lab
// (C39-DESIGN-SUPREME.md / C39-RESULTS-SUPREME.md / supreme.cjs and
// C39-DESIGN-POOL.md / C39-RESULTS-POOL.md / pool.cjs) to the SDK
// module:
//   - FP-EXACT / FP-ROUND / FP-CROSS: lab 0% on every value
//     (15/15 FP values absolute zero) - honest and cross-key
//     editions must NOT confirm here;
//   - G7 noise +-1: lab combined 100% (the tens/hundreds scales
//     carry the edition while the units scale degrades to ~94%);
//   - G10 rounding to hundreds: lab combined 100%, carried by the
//     hundreds scale alone;
//   - K3 recompute-from-components: lab 0% - a STRUCTURAL death,
//     pinned below: totals recomputed as q * p carry no residue
//     by construction;
//   - EV-ALL: an evader who knows the whole configuration breaks
//     the watermark (lab 0%) - the declared boundary, pinned
//     below, not a bug to be "fixed" into a claim never measured;
//   - C39-POOL: LOW-tier (T < 2,000) records cannot self-confirm
//     at small n (the R-ADAPT 8 SD floor), but pooling the LOW
//     evidence of many editions of the same key confirms (lab:
//     94% at 80 pooled editions, n ~ 421; every FP cell 0%).
// The dataset generator is the lab's shape verbatim (500 records,
// q in [1,50], p integer in [100,10000], T = q * p); only the RNG
// stream differs, and the SDK module's g is a declared port
// deviation (a different keyed stream with the same uniform
// {0..6} distribution - see the module header).
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

function buildDataset(seed) {
  const rng = mulberry32(seed);
  const recs = [];
  for (let i = 0; i < 500; i++) {
    const q = 1 + Math.floor(rng() * 50);
    const p = 100 + Math.floor(rng() * 9901);
    recs.push({ id: i, q, p });
  }
  return recs;
}

const KEY_A = 'host-secret-A';
const KEY_B = 'host-secret-B';
const ED = 'edition-2026-11';

function markedEdition(seed = 20261111, key = KEY_A) {
  const inst = sdk.createValueWatermark({ key });
  const recs = buildDataset(seed);
  return { inst, recs, marked: inst.markEdition(ED, recs) };
}

/* ---------------- hard condition 1: host key is mandatory ---------------- */

test('missing or empty key throws a named ValueWatermarkError at construction', () => {
  for (const options of [undefined, {}, { key: '' }, { key: '   ' }, { key: 42 }]) {
    assert.throws(
      () => sdk.createValueWatermark(options),
      (err) => err.name === 'ValueWatermarkError',
      `options ${JSON.stringify(options)} must throw`,
    );
  }
});

test('corrupt records throw a named error; a plain mismatch never throws', () => {
  const { inst } = markedEdition();
  assert.throws(
    () => inst.markEdition(ED, [{ id: '', q: 1, p: 100 }]),
    (err) => err.name === 'ValueWatermarkError',
  );
  assert.throws(
    () => inst.verifyEdition(ED, [{ id: 1, q: NaN, p: 100, publishedTotal: 100 }]),
    (err) => err.name === 'ValueWatermarkError',
  );
  assert.throws(
    () => inst.verifyEdition(ED, [{ id: 1, q: 1, p: 100, publishedTotal: Infinity }]),
    (err) => err.name === 'ValueWatermarkError',
  );
  // Not corrupt, just wrong: a result, not an exception.
  const res = inst.verifyEdition(ED, [{ id: 1, q: 1, p: 100, publishedTotal: 999999 }]);
  assert.equal(res.confirmed, false);
  assert.equal(res.enforcement, 'none');
});

/* ---------------- the lab's decisive cells ---------------- */

test('roundtrip: a marked edition verifies confirmed on all three scales', () => {
  const { inst, marked } = markedEdition();
  const snapshot = marked.map((r) => ({ ...r }));
  const res = inst.verifyEdition(ED, marked);
  assert.equal(res.confirmed, true);
  assert.equal(res.scales.unit.confirmed, true);
  assert.equal(res.scales.tens.confirmed, true);
  assert.equal(res.scales.hundreds.confirmed, true);
  assert.equal(res.scales.unit.eligible, 500);
  assert.equal(res.scales.unit.matches, 500);
  assert.equal(res.enforcement, 'none');
  // markEdition must not mutate its input records.
  const { recs } = markedEdition();
  assert.equal(recs[0].publishedTotal, undefined);
  assert.deepEqual(marked, snapshot);
});

test('FP-EXACT: an honest unmarked edition does not confirm (lab 0%)', () => {
  const inst = sdk.createValueWatermark({ key: KEY_A });
  const honest = buildDataset(20261111).map((r) => ({ ...r, publishedTotal: r.q * r.p }));
  const res = inst.verifyEdition(ED, honest);
  assert.equal(res.confirmed, false);
  assert.equal(res.scales.unit.confirmed, false);
  assert.equal(res.scales.tens.confirmed, false);
  assert.equal(res.scales.hundreds.confirmed, false);
});

test('FP-ROUND: an honest edition with its own rounding residue does not confirm (lab 0%)', () => {
  const inst = sdk.createValueWatermark({ key: KEY_A });
  const rng = mulberry32(4242);
  const honest = buildDataset(20261111).map((r) => {
    let publishedTotal = r.q * r.p;
    if (rng() < 0.5) publishedTotal += Math.floor(rng() * 3) - 1;
    return { ...r, publishedTotal };
  });
  assert.equal(inst.verifyEdition(ED, honest).confirmed, false);
});

test('FP-CROSS: an edition marked under key A does not confirm under key B (lab 0%)', () => {
  const { marked } = markedEdition(20261111, KEY_A);
  const other = sdk.createValueWatermark({ key: KEY_B });
  assert.equal(other.verifyEdition(ED, marked).confirmed, false);
});

test('G7 noise +-1: the edition still confirms, carried by tens/hundreds (lab combined 100%)', () => {
  const { inst, marked } = markedEdition();
  const rng = mulberry32(20261121);
  const noised = marked.map((r) => ({ ...r, publishedTotal: r.publishedTotal + (Math.floor(rng() * 3) - 1) }));
  const res = inst.verifyEdition(ED, noised);
  assert.equal(res.confirmed, true, JSON.stringify(res.scales));
  assert.equal(res.scales.tens.confirmed, true);
  assert.equal(res.scales.hundreds.confirmed, true);
});

test('G10 rounding to hundreds: the edition still confirms on the hundreds scale (lab 100%)', () => {
  const { inst, marked } = markedEdition();
  const rounded = marked.map((r) => ({ ...r, publishedTotal: Math.round(r.publishedTotal / 100) * 100 }));
  const res = inst.verifyEdition(ED, rounded);
  assert.equal(res.confirmed, true, JSON.stringify(res.scales));
  assert.equal(res.scales.hundreds.confirmed, true);
  assert.equal(res.scales.unit.confirmed, false);
  assert.equal(res.scales.tens.confirmed, false);
});

test('K3 recompute-from-components does NOT confirm (structural death, pinned)', () => {
  // A republisher who recomputes every total as q * p carries no
  // residue at all: confirmation is 0% BY CONSTRUCTION (lab K3).
  // This pins the death as a contract - C39 claims provenance
  // only through chains that carry the published totals.
  const { inst, marked } = markedEdition();
  const recomputed = marked.map((r) => ({ ...r, publishedTotal: r.q * r.p }));
  const res = inst.verifyEdition(ED, recomputed);
  assert.equal(res.confirmed, false);
  assert.equal(res.scales.unit.matches / res.scales.unit.eligible < 0.3, true);
});

test('EV-ALL: an evader who knows the whole configuration breaks the watermark (declared boundary, pinned)', () => {
  // Lab EV-ALL verbatim: per record, subtract the tier's expected
  // residue (3 / 33 / 333) and add a fake residue with the exact
  // placement structure of the record's tier. Knowing everything
  // breaks it completely (lab 0%) - the boundary the lab declared
  // before running, asserted here so it is never silently
  // "improved" into an unmeasured claim.
  const { inst, marked } = markedEdition();
  const rng = mulberry32(20261131);
  const forged = marked.map((r) => {
    const T = r.q * r.p;
    const tier = T < 2000 ? 'low' : T < 20000 ? 'mid' : 'high';
    const expected = tier === 'low' ? 3 : tier === 'mid' ? 33 : 333;
    let fake = Math.floor(rng() * 7);
    if (tier !== 'low') fake += 10 * Math.floor(rng() * 7);
    if (tier === 'high') fake += 100 * Math.floor(rng() * 7);
    return { ...r, publishedTotal: r.publishedTotal - expected + fake };
  });
  assert.equal(inst.verifyEdition(ED, forged).confirmed, false);
});

/* ---------------- pooled LOW evidence (C39-POOL) ---------------- */

test('pooled LOW: small editions never self-confirm, the pooled LOW status confirms (lab 94% at the gate size)', () => {
  // LOW-only editions (every T < 2,000, units scale only), marked
  // and noised +-1. A single edition of 40 LOW records cannot
  // confirm: R-ADAPT demands matches >= expectation + 8 SD, far
  // above the ~1/3 match rate noise leaves. Pooling 25 editions
  // through verifyEdition on ONE instance accumulates n = 1,000
  // LOW records, where the same 1/3 rate clears the floor.
  const rng = mulberry32(777001);
  const inst = sdk.createValueWatermark({ key: 'pool-key' });
  for (let e = 0; e < 25; e++) {
    const recs = [];
    for (let i = 0; i < 40; i++) {
      const q = 1 + Math.floor(rng() * 9);
      const p = 100 + Math.floor(rng() * 90);
      recs.push({ id: i, q, p });
    }
    const marked = inst.markEdition(`pool-ed-${e}`, recs);
    const noised = marked.map((r) => ({ ...r, publishedTotal: r.publishedTotal + (Math.floor(rng() * 3) - 1) }));
    const res = inst.verifyEdition(`pool-ed-${e}`, noised);
    assert.equal(res.confirmed, false, `single LOW edition ${e} must not self-confirm`);
  }
  const status = inst.pooledLowStatus();
  assert.equal(status.editions, 25);
  assert.equal(status.eligible, 1000);
  assert.ok(status.matches / status.eligible > 0.3, `pooled match fraction ${status.matches}/${status.eligible}`);
  assert.equal(status.confirmed, true);
  inst.resetPooledLow();
  assert.deepEqual(inst.pooledLowStatus(), { editions: 0, eligible: 0, matches: 0, confirmed: false });
});

/* ---------------- group totals ---------------- */

test('group totals: marked groups match exactly and confirm; honest groups do not (lab G3 100%)', () => {
  const { inst, marked } = markedEdition();
  const rng = mulberry32(20261141);
  const shuffled = [...marked];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const groups = [];
  for (let s = 0; s + 10 <= shuffled.length; s += 10) {
    const members = shuffled.slice(s, s + 10);
    groups.push({
      records: members.map(({ id, q, p }) => ({ id, q, p })),
      publishedTotal: members.reduce((sum, r) => sum + r.publishedTotal, 0),
    });
  }
  const res = inst.verifyGroupTotals(ED, groups);
  assert.equal(res.totalGroups, 50);
  assert.equal(res.matchedGroups, 50);
  assert.equal(res.confirmed, true);
  assert.equal(res.enforcement, 'none');

  const honestGroups = groups.map((grp) => ({
    records: grp.records,
    publishedTotal: grp.records.reduce((sum, r) => sum + r.q * r.p, 0),
  }));
  const honestRes = inst.verifyGroupTotals(ED, honestGroups);
  assert.equal(honestRes.confirmed, false);
});

/* ---------------- distortion + placement golden sample ---------------- */

test('distortion: residue is bounded by 666, tier-shaped, and matches the golden placement sample', () => {
  const inst = sdk.createValueWatermark({ key: 'golden-key' });
  // Golden sample: the exact placement residues of the SDK stream
  // for a fixed (key, edition) - pins placement per tier: LOW
  // carries units only, MID units+tens, HIGH all three scales.
  const sample = [
    { id: 'r-low', q: 1, p: 500 }, // T = 500 -> a = 1
    { id: 7, q: 10, p: 500 }, // T = 5,000 -> a = 50
    { id: 9, q: 2, p: 30000 }, // T = 60,000 -> a = 441
    { id: 0, q: 50, p: 10000 }, // T = 500,000 -> a = 504
  ];
  const expectedA = [1, 50, 441, 504];
  const golden = inst.markEdition('golden-ed', sample);
  golden.forEach((r, i) => {
    assert.equal(r.publishedTotal - r.q * r.p, expectedA[i], `golden residue for record ${i}`);
  });

  const { inst: inst2, recs, marked } = markedEdition(20261111);
  void inst2;
  const ratios = [];
  marked.forEach((r, i) => {
    const T = recs[i].q * recs[i].p;
    const a = r.publishedTotal - T;
    assert.ok(a >= 0 && a <= 666, `residue ${a} out of [0, 666]`);
    if (T < 2000) assert.ok(a < 10, 'LOW tier carries the units digit only');
    else if (T < 20000) assert.ok(a < 100, 'MID tier carries units + tens only');
    ratios.push(a / T);
  });
  ratios.sort((x, y) => x - y);
  const median = ratios[Math.floor(ratios.length / 2)];
  const p99 = ratios[Math.floor(ratios.length * 0.99)];
  // Lab (different stream, same placement): median 0.229%, p99 2.18%.
  assert.ok(median < 0.005, `median distortion ${median} must stay small`);
  assert.ok(p99 < 0.03, `p99 distortion ${p99} must stay small`);
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof sdk.createValueWatermark, 'function');
  assert.equal(typeof sdk.ValueWatermarkError, 'function');
  const { inst } = markedEdition();
  assert.equal(inst.enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
