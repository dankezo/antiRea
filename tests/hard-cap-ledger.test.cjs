'use strict';
// NHS-08 hard-cap ledger - suite version of nhs-lab/nhs08.cjs,
// upgraded form: ONLY the accounting invariant is built (a hard-cap
// ledger for a host's own mechanism); no tarpit or delay mechanism
// exists in the module. Frozen expectations: total never exceeds 4
// across the 13-event scenario, invariant after every event, at-cap
// refusal is never queued, single decrement path, respawn zeroes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hl = require('../dist/tier2-active/hard-cap-ledger.js');

test('13-event lab scenario: cap holds after every event, counter ends at exactly 0', () => {
  const led = hl.createHardCapLedger({ cap: 4, workers: 2 });
  const steps = [];
  const step = (label, fn) => {
    const r = fn();
    const snap = led.snapshot();
    steps.push({ label, result: r, total: snap.total, perWorker: snap.perWorker, invariant: snap.invariantOk });
  };
  step('open c1(w0)', () => led.tryReserve('c1', 0));
  step('open c2(w0)', () => led.tryReserve('c2', 0));
  step('open c3(w1)', () => led.tryReserve('c3', 1));
  step('open c4(w1)', () => led.tryReserve('c4', 1));
  step('open c5(w0) at cap', () => led.tryReserve('c5', 0));
  step('abort c2', () => led.release('c2'));
  step('c5 still not admitted', () => led.has('c5'));
  step('open c6(w1)', () => led.tryReserve('c6', 1));
  step('deadline c1', () => led.release('c1'));
  step('release c1 again', () => led.release('c1'));
  step('respawn w1', () => { led.respawnWorker(1); return led.total(); });
  step('open c7(w0)', () => led.tryReserve('c7', 0));
  step('close c7', () => led.release('c7'));

  const get = (label) => steps.find((s) => s.label === label);
  assert.ok(steps.every((s) => s.invariant), 'invariant holds after every event');
  assert.equal(led.snapshot().maxObserved, 4, 'total never exceeds the cap of 4');
  assert.equal(get('open c5(w0) at cap').result, false, 'at-cap reserve refused immediately');
  assert.equal(get('c5 still not admitted').result, false, 'no queue: a refused id is not admitted when a slot frees');
  assert.equal(get('abort c2').total, 3);
  assert.equal(get('deadline c1').total, 3);
  assert.equal(get('release c1 again').result, false, 'double release is a no-op (single decrement path)');
  assert.equal(get('release c1 again').total, 3);
  assert.equal(get('respawn w1').total, 0, 'respawn drops the total 3 to 0 with its three live holds');
  assert.deepEqual(get('respawn w1').perWorker, [0, 0]);
  assert.equal(led.total(), 0);
});

test('the ledger has no delay surface: reserves and releases are synchronous booleans', () => {
  const led = hl.createHardCapLedger({ cap: 1 });
  assert.equal(typeof led.tryReserve('x'), 'boolean');
  assert.equal(led.tryReserve('y'), false);
  assert.equal(typeof led.release('x'), 'boolean');
  assert.equal(led.total(), 0);
});

test('invalid configuration is a loud construction error', () => {
  assert.throws(() => hl.createHardCapLedger({ cap: 0 }), TypeError);
  assert.throws(() => hl.createHardCapLedger({ cap: 4, workers: 0 }), TypeError);
  const led = hl.createHardCapLedger({ cap: 2, workers: 2 });
  assert.throws(() => led.tryReserve('x', 2), TypeError);
});
