const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDecoyTripwire, DecoyTripwireError } = require('../dist/tier2-active/decoy-tripwire.js');

// ---------------------------------------------------------------------------
// Decoy tripwire (HARVEST2 candidate C35, CANDECOY). These tests pin
// the SDK port of the lab's decisive cells (C35-DESIGN.md /
// C35-RESULTS.md / C35-RESULTS-RANDOM.md):
//   - NAV legit never touches a decoy (lab: 0/1,200 identities,
//     1,115,408 requests; RANDOM re-run 0/1,200, 1,112,209 requests)
//     - mirrored here as: an identity fed only ordinary resources is
//     never flagged;
//   - enumeration sensitivity 1.000 at K in {7, 20, 50} x every
//     order, pattern and RANDOM placement alike, and the learning
//     evader still touches >= 1 at 100% - mirrored here as: a single
//     decoy touch flags, and the first-touch timestamp is kept;
//   - the narrowed claim is a contract, not a comment: `flagged`
//     means exactly "touched >= 1 declared decoy" (an enumeration
//     tripwire), enforcement is "none" everywhere, and the module
//     DISABLES itself when the host declares no decoy resources
//     (the C22/C9 hard-condition precedent).
// The full-population re-run of the lab generators against this
// module lives in the study lab (c35-lab/sdk-recheck.cjs).
// ---------------------------------------------------------------------------

const DECOYS = [2001, 2017, 2051];

test('no decoy declaration: the module is disabled and records nothing', () => {
  for (const inst of [createDecoyTripwire(), createDecoyTripwire({})]) {
    assert.equal(inst.enabled, false);
    const obs = inst.observe({ identity: 'a', resourceId: 2001, ts: 1000 });
    assert.equal(obs.status, 'disabled');
    assert.equal(obs.counted, false);
    const sig = inst.evaluateIdentity('a');
    assert.equal(sig.status, 'disabled');
    assert.equal(sig.touched, false);
    assert.equal(sig.flagged, false);
    assert.equal(sig.touchCount, 0);
    assert.equal(sig.firstTouchAt, null);
    assert.equal(sig.enforcement, 'none');
    const snap = inst.snapshot();
    assert.equal(snap.disabled, true);
    assert.equal(snap.disabledReason, 'decoy_resources_not_declared');
    assert.equal(snap.identitiesTouched, 0);
    assert.equal(snap.totalDecoyTouches, 0);
    assert.equal(snap.totalRequestsSeen, 0);
  }
});

test('an identity that touches a decoy is flagged with the exact first-touch time', () => {
  const inst = createDecoyTripwire({ decoyResourceIds: DECOYS });
  assert.equal(inst.enabled, true);
  inst.observe({ identity: 'walker', resourceId: 10, ts: 100 });
  const first = inst.observe({ identity: 'walker', resourceId: 2001, ts: 250 });
  assert.equal(first.status, 'recorded');
  assert.equal(first.decoy, true);
  assert.equal(first.touchCount, 1);
  // Later touches keep the FIRST touch time.
  const second = inst.observe({ identity: 'walker', resourceId: 2017, ts: 900 });
  assert.equal(second.touchCount, 2);
  const sig = inst.evaluateIdentity('walker');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.touched, true);
  assert.equal(sig.flagged, true);
  assert.equal(sig.touchCount, 2);
  assert.equal(sig.firstTouchAt, 250);
  assert.equal(sig.enforcement, 'none');
});

test('an identity that only touches ordinary resources is not flagged', () => {
  const inst = createDecoyTripwire({ decoyResourceIds: DECOYS });
  for (let i = 0; i < 50; i++) {
    const obs = inst.observe({ identity: 'nav-user', resourceId: i, ts: i * 1000 });
    assert.equal(obs.status, 'recorded');
    assert.equal(obs.decoy, false);
  }
  const sig = inst.evaluateIdentity('nav-user');
  assert.equal(sig.status, 'scored');
  assert.equal(sig.touched, false);
  assert.equal(sig.flagged, false);
  assert.equal(sig.touchCount, 0);
  assert.equal(sig.firstTouchAt, null);
});

test('an identity never fed to observe is unknown_identity, not flagged', () => {
  const inst = createDecoyTripwire({ decoyResourceIds: DECOYS });
  inst.observe({ identity: 'someone', resourceId: 1, ts: 0 });
  const sig = inst.evaluateIdentity('ghost');
  assert.equal(sig.status, 'unknown_identity');
  assert.equal(sig.touched, false);
  assert.equal(sig.flagged, false);
  assert.equal(sig.touchCount, 0);
  assert.equal(sig.firstTouchAt, null);
});

test('the request denominator and the snapshot counters are exact', () => {
  const inst = createDecoyTripwire({ decoyResourceIds: new Set(DECOYS) });
  inst.observe({ identity: 'a', resourceId: 1, ts: 0 });
  inst.observe({ identity: 'a', resourceId: 2001, ts: 1 });
  inst.observe({ identity: 'a', resourceId: 2001, ts: 2 });
  inst.observe({ identity: 'b', resourceId: 2, ts: 3 });
  inst.observe({ identity: 'b', resourceId: 2051, ts: 4 });
  inst.observe({ identity: 'c', resourceId: 3, ts: 5 });
  const snap = inst.snapshot();
  assert.equal(snap.totalRequestsSeen, 6);
  assert.equal(snap.totalDecoyTouches, 3);
  assert.equal(snap.identitiesTouched, 2);
  assert.equal(snap.disabled, false);
  assert.equal(snap.enabled, true);
  assert.equal(snap.disabledReason, null);
  assert.equal(snap.enforcement, 'none');
});

test('invalid timestamps are refused as no-ops, even on a decoy resource', () => {
  const inst = createDecoyTripwire({ decoyResourceIds: DECOYS });
  for (const ts of [NaN, Infinity, -Infinity, 8.64e15 + 1]) {
    const obs = inst.observe({ identity: 'a', resourceId: 2001, ts });
    assert.equal(obs.status, 'invalid_ts');
    assert.equal(obs.counted, false);
  }
  const snap = inst.snapshot();
  assert.equal(snap.totalRequestsSeen, 0);
  assert.equal(snap.totalDecoyTouches, 0);
  assert.equal(snap.identitiesTouched, 0);
  assert.equal(inst.evaluateIdentity('a').status, 'unknown_identity');
});

test('the isDecoyResource predicate declaration works on its own', () => {
  const inst = createDecoyTripwire({ isDecoyResource: (id) => typeof id === 'string' && id.startsWith('/decoy/') });
  inst.observe({ identity: 'a', resourceId: '/real/1', ts: 10 });
  inst.observe({ identity: 'a', resourceId: '/decoy/x', ts: 20 });
  const sig = inst.evaluateIdentity('a');
  assert.equal(sig.flagged, true);
  assert.equal(sig.firstTouchAt, 20);
  assert.equal(inst.snapshot().totalRequestsSeen, 2);
});

test('a throwing host predicate is treated as "not a decoy", never as a crash', () => {
  const inst = createDecoyTripwire({
    isDecoyResource: () => {
      throw new Error('host bug');
    },
  });
  const obs = inst.observe({ identity: 'a', resourceId: 1, ts: 0 });
  assert.equal(obs.status, 'recorded');
  assert.equal(obs.decoy, false);
  assert.equal(inst.evaluateIdentity('a').flagged, false);
});

test('malformed fields other than ts throw the named error', () => {
  const inst = createDecoyTripwire({ decoyResourceIds: DECOYS });
  for (const bad of [
    { identity: '', resourceId: 1, ts: 0 },
    { identity: 'a', resourceId: NaN, ts: 0 },
    { identity: 'a', resourceId: '', ts: 0 },
  ]) {
    assert.throws(() => inst.observe(bad), (err) => err.name === 'DecoyTripwireError' && err instanceof DecoyTripwireError);
  }
  assert.throws(() => inst.evaluateIdentity(''), (err) => err.name === 'DecoyTripwireError');
  assert.throws(() => createDecoyTripwire({ decoyResourceIds: [NaN] }), (err) => err.name === 'DecoyTripwireError');
  assert.throws(() => createDecoyTripwire({ isDecoyResource: 42 }), (err) => err.name === 'DecoyTripwireError');
  // Nothing from the malformed calls was recorded.
  assert.equal(inst.snapshot().totalRequestsSeen, 0);
});

test('advisory-only surface: enforcement is none everywhere and no blocking API exists', () => {
  assert.equal(typeof createDecoyTripwire, 'function');
  const inst = createDecoyTripwire({ decoyResourceIds: DECOYS });
  assert.equal(inst.snapshot().enforcement, 'none');
  inst.observe({ identity: 'a', resourceId: 2001, ts: 0 });
  assert.equal(inst.evaluateIdentity('a').enforcement, 'none');
  for (const name of ['checkServe', 'reserve', 'reserveServe', 'decide', 'block', 'enforce']) {
    assert.equal(inst[name], undefined, `instance must not expose ${name}`);
  }
});
