'use strict';
// WDN-06 fingerprint correlation counts - suite version of wdn-lab/wdn06.cjs.
// Frozen lab properties: fires exactly on the 6th distinct fingerprint
// per IP (threshold strictly greater) and the 11th distinct IP per
// fingerprint; repeats never fire.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('../dist/tier2-active/wdn-fingerprint-correlation.js');

const IP1 = '198.51.100.10';

test('FPC-IPTHRESH: 6 distinct fingerprints from one IP fire exactly on the 6th, at 0.6/0.6; 5 never fire', () => {
  const sig = fc.createFingerprintCorrelationSignal();
  for (let i = 1; i <= 5; i++) {
    assert.deepEqual(sig.observe({ fingerprint: `canvas-${i}`, ip: IP1 }), [], `request ${i}`);
  }
  const sixth = sig.observe({ fingerprint: 'canvas-6', ip: IP1 });
  assert.equal(sixth.length, 1);
  assert.equal(sixth[0].kind, 'ip_fingerprint');
  assert.equal(sixth[0].score, 0.6);
  assert.equal(sixth[0].confidence, 0.6);
  assert.equal(sixth[0].enforcement, 'none');
});

test('FPC-FPTHRESH: one fingerprint from 11 IPs fires exactly on the 11th, at 0.5/0.5; 10 never fire', () => {
  const sig = fc.createFingerprintCorrelationSignal();
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(sig.observe({ fingerprint: 'canvas-fixed', ip: `198.51.100.${20 + i}` }), [], `ip ${i}`);
  }
  const eleventh = sig.observe({ fingerprint: 'canvas-fixed', ip: '198.51.100.30' });
  assert.equal(eleventh.length, 1);
  assert.equal(eleventh[0].kind, 'fingerprint_ip');
  assert.equal(eleventh[0].score, 0.5);
  assert.equal(eleventh[0].confidence, 0.5);
});

test('FPC-DISTINCT: the same IP and same fingerprint repeated 6 times never fires', () => {
  const sig = fc.createFingerprintCorrelationSignal();
  for (let i = 0; i < 6; i++) {
    assert.deepEqual(sig.observe({ fingerprint: 'canvas-fixed', ip: IP1 }), []);
  }
  assert.deepEqual(sig.counts({ fingerprint: 'canvas-fixed', ip: IP1 }), {
    distinctFingerprintsForIp: 1,
    distinctIpsForFingerprint: 1,
  });
});
