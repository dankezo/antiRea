const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-05 (upgrade attempt): gating signals must be server-measured
// or cryptographically bound. Neighbour measurement (abs-lab
// RESULTS-ABS-STEP0): a verify carrying FABRICATED clean signals
// passed with risk 0 and a cookie set; the only consistency check
// (fp_hash == sha256(fp_raw)) is vacuous because both values are
// attacker-computed. Audit of antiRea's gating inputs:
// - flow-scorer inputs are host-fed SERVER observations (route
//   class, response status, records returned) - server-measured by
//   construction when the host feeds them from its own serving
//   path, which is the module's documented contract.
// - cdp-guard inputs (navigator.webdriver and friends) are
//   client-supplied and CANNOT be bound from inside a browser:
//   that gap is structural, and the module already confines them
//   to low-confidence telemetry. It is gap-flagged below, not
//   papered over.
// - a client-supplied value becomes gating-ready only when it
//   arrives inside a cryptographically verified container (a
//   step-up proof payload, a Web Bot Auth signature, a signed
//   cursor) - the binding, not the value, is what counts.
// `auditSignalInputs` encodes exactly this classification and
// `assertGatingInputsBound` refuses a gating configuration that
// rests on unbound client-supplied inputs.

const FABRICATED_CLEAN = [
  { name: 'webdriver', provenance: 'client-supplied' },
  { name: 'has_webcrypto', provenance: 'client-supplied' },
  { name: 'canvas_hash', provenance: 'client-supplied' },
  { name: 'fp_hash', provenance: 'client-supplied' },
];

test('ABS-05: fabricated clean client signals are NOT gating-ready (neighbour fixture)', () => {
  const audit = sdk.auditSignalInputs(FABRICATED_CLEAN);
  assert.equal(audit.gatingReady, false);
  assert.deepEqual(audit.unbound.sort(), ['canvas_hash', 'fp_hash', 'has_webcrypto', 'webdriver']);
  assert.throws(() => sdk.assertGatingInputsBound(FABRICATED_CLEAN), sdk.SignalBindingError);
});

test('ABS-05: server-measured inputs are gating-ready', () => {
  const inputs = [
    { name: 'routeClass', provenance: 'server-measured' },
    { name: 'responseStatus', provenance: 'server-measured' },
    { name: 'recordsReturned', provenance: 'server-measured' },
  ];
  const audit = sdk.auditSignalInputs(inputs);
  assert.equal(audit.gatingReady, true);
  assert.deepEqual(audit.unbound, []);
  sdk.assertGatingInputsBound(inputs); // does not throw
});

test('ABS-05: a client-supplied value counts only when cryptographically bound', () => {
  const bound = [{ name: 'challengeOutcome', provenance: 'client-supplied', bound: true }];
  assert.equal(sdk.auditSignalInputs(bound).gatingReady, true);
  const unbound = [{ name: 'challengeOutcome', provenance: 'client-supplied', bound: false }];
  assert.equal(sdk.auditSignalInputs(unbound).gatingReady, false);
});

test('ABS-05: the cdp-guard gap is named, not hidden', () => {
  // The shipped browser-side signals can never be bound from inside
  // the browser. The audit of that exact input set must keep saying
  // so, and the gap constant must keep naming the confinement
  // (telemetry only, never a gate).
  const audit = sdk.auditSignalInputs([{ name: 'navigator.webdriver', provenance: 'client-supplied' }]);
  assert.equal(audit.gatingReady, false);
  assert.match(sdk.CDP_GUARD_BINDING_GAP, /telemetry/);
  assert.match(sdk.CDP_GUARD_BINDING_GAP, /never/);
});

test('ABS-05: malformed descriptors fail closed', () => {
  assert.throws(() => sdk.auditSignalInputs([{ name: 'x', provenance: 'vibes' }]), sdk.SignalBindingError);
  assert.throws(() => sdk.auditSignalInputs([{ provenance: 'server-measured' }]), sdk.SignalBindingError);
  assert.throws(() => sdk.auditSignalInputs('nope'), sdk.SignalBindingError);
});
