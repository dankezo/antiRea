'use strict';
// NHS-03 FCrDNS - suite version of nhs-lab/nhs03.cjs. Frozen
// expectations: 2 VERIFIED, 2 FAILED, 2 PENDING-uncached; spoofed
// wiring 50 vs verified 0; TTL cache exact; first request served
// PENDING under the legacy short-circuit (the recorded window).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('../dist/tier2-active/fcrdns-lookup.js');

const DNS = {
  '66.249.66.1': { ptr: 'crawl-66-249-66-1.googlebot.com', forward: ['66.249.66.1'] },
  '66.249.66.2': { ptr: 'crawl-66-249-66-2.googlebot.com', forward: ['66.249.66.2'] },
  '203.0.113.66': { ptr: 'crawl.fake-example.com', forward: ['203.0.113.66'] },
  '198.51.100.66': { ptr: null },
  '192.0.2.66': { ptr: 'host.googlebot.com', forward: ['192.0.2.99'] },
  '203.0.113.99': { error: true },
};

function makeWorld() {
  const calls = {};
  const resolve = (ip) => {
    calls[ip] = (calls[ip] || 0) + 1;
    const f = DNS[ip];
    if (!f || f.error) return { type: 'error' };
    if (!f.ptr) return { type: 'noptr' };
    return { type: 'ptr', host: f.ptr, forward: f.forward || [] };
  };
  let now = 1000;
  const lookup = fc.createFcrdnsLookup({ resolve, suffixes: ['.googlebot.com'], ttlMs: 3600000, now: () => now });
  return { calls, lookup, setNow: (t) => { now = t; } };
}

test('verdicts: 2 VERIFIED, 2 FAILED (wrong suffix, forward mismatch), 2 PENDING-uncached', async () => {
  const { calls, lookup } = makeWorld();
  const flow = {};
  for (const ip of Object.keys(DNS)) {
    const r1 = await lookup.lookup(ip);
    const r2 = await lookup.lookup(ip);
    flow[ip] = { req1: r1.state, req2: r2.state, calls: calls[ip] };
  }
  assert.equal(flow['66.249.66.1'].req2, 'VERIFIED');
  assert.equal(flow['66.249.66.2'].req2, 'VERIFIED');
  assert.equal(flow['203.0.113.66'].req2, 'FAILED');
  assert.equal(flow['192.0.2.66'].req2, 'FAILED');
  assert.equal(flow['198.51.100.66'].req2, 'PENDING');
  assert.equal(flow['203.0.113.99'].req2, 'PENDING');
  assert.equal(flow['198.51.100.66'].calls, 2, 'no-PTR caches nothing: re-resolves');
  assert.equal(flow['203.0.113.99'].calls, 2, 'transient error caches nothing: re-resolves');
});

test('known window: every first request from an unknown IP is served PENDING', async () => {
  const { lookup } = makeWorld();
  for (const ip of Object.keys(DNS)) {
    const r1 = await lookup.lookup(ip);
    assert.equal(r1.state, 'PENDING', ip);
    assert.equal(r1.cached, false);
    assert.equal(fc.scoreUnderFcrdnsState(r1.state, true), 0, 'PENDING short-circuits like the legacy path');
  }
});

test('wiring: spoofed (FAILED) scores 50 vs verified 0 under the same scanner input', async () => {
  assert.equal(fc.scoreUnderFcrdnsState('FAILED', true), 50);
  assert.equal(fc.scoreUnderFcrdnsState('VERIFIED', true), 0);
  assert.equal(fc.scoreUnderFcrdnsState('FAILED', false), 0);
});

test('BS-01 facts: VERIFIED delta 0, FAILED is spoofed EVIDENCE, PENDING delta 0', async () => {
  const { lookup } = makeWorld();
  await lookup.lookup('66.249.66.1');
  const v = await lookup.lookup('66.249.66.1');
  assert.equal(v.fact.state, 'verified');
  assert.equal(v.fact.evidenceDelta, 0);
  await lookup.lookup('203.0.113.66');
  const f = await lookup.lookup('203.0.113.66');
  assert.equal(f.fact.state, 'spoofed');
  assert.equal(f.fact.evidenceDelta, 'EVIDENCE');
  const p = await lookup.lookup('198.51.100.66');
  assert.equal(p.fact.state, 'unverified');
  assert.equal(p.fact.evidenceDelta, 0);
});

test('cache: within-TTL repeat costs 0 resolver calls; post-TTL re-resolves once', async () => {
  const { calls, lookup, setNow } = makeWorld();
  await lookup.lookup('66.249.66.1'); // t=1000, resolves (call 1), serves PENDING
  const r2 = await lookup.lookup('66.249.66.1');
  assert.equal(r2.state, 'VERIFIED');
  assert.equal(r2.cached, true);
  const before = calls['66.249.66.1'];
  setNow(1000 + 20000);
  const r3 = await lookup.lookup('66.249.66.1');
  assert.equal(r3.state, 'VERIFIED');
  assert.equal(calls['66.249.66.1'], before, 'within TTL: no new resolver call');
  setNow(1000 + 3600000 + 1000);
  const r4 = await lookup.lookup('66.249.66.1');
  assert.equal(r4.state, 'PENDING', 'the re-resolving request itself serves PENDING again');
  assert.equal(calls['66.249.66.1'], before + 1);
});
