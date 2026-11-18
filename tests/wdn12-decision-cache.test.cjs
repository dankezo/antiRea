'use strict';
// WDN-12 decision-cache policy - suite version of wdn-lab/wdn12.cjs.
// Frozen lab properties: network DENYs cached and re-served with rules
// still re-run, +61 s TTL miss, ALLOWs never stored, rule decisions
// never absorbed, 10,001 inserts capped at 10,000 oldest-first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const dc = require('../dist/tier2-active/wdn-decision-cache.js');

function makeHarness(networkConclusion) {
  const clock = { t: 1768478400000, now() { return this.t; } };
  const cache = dc.createDecisionCache({ now: () => clock.t });
  const decider = dc.createCachedDecider(cache);
  const state = { ruleEvaluations: 0, violations: 0, networkCalls: 0, lastSetReturn: null };
  function decide(key, path) {
    return decider.decide(
      key,
      () => {
        state.ruleEvaluations++;
        if (path === '/.env') {
          state.violations++;
          return { conclusion: 'DENY', origin: 'rule', results: [{ rule: 'tripwire', state: 'RUN', conclusion: 'DENY', action: 'DENY' }] };
        }
        return null;
      },
      () => {
        state.networkCalls++;
        return { conclusion: networkConclusion, origin: 'network', results: [{ rule: 'network', state: 'RUN', conclusion: networkConclusion, action: networkConclusion }] };
      },
    );
  }
  return { clock, cache, state, decide };
}

test('DC-DENY and DC-RULES-RUN: a network DENY is stored, re-served from cache with states CACHED, network still 1, rules run again', () => {
  const h = makeHarness('DENY');
  const a = h.decide('K', '/page');
  assert.equal(a.source, 'network');
  assert.equal(h.state.networkCalls, 1);
  assert.equal(h.cache.size, 1);
  h.clock.t += 1000;
  const b = h.decide('K', '/page');
  assert.equal(b.source, 'cache');
  assert.ok(b.decision.results.every((r) => r.state === 'CACHED'));
  assert.equal(h.state.networkCalls, 1);
  assert.equal(h.state.ruleEvaluations, 2);
});

test('DC-TTL: after +61 s the same key misses and the network is called a second time', () => {
  const h = makeHarness('DENY');
  h.decide('K', '/page');
  h.clock.t += 61000;
  const c = h.decide('K', '/page');
  assert.equal(c.source, 'network');
  assert.equal(h.state.networkCalls, 2);
});

test('DC-ALLOW: an ALLOW decision is never stored; the next request calls the network again', () => {
  const cache = dc.createDecisionCache({ now: () => 1000 });
  assert.equal(cache.set('K2', { conclusion: 'ALLOW', origin: 'network' }), false);
  assert.equal(cache.size, 0);
  const h = makeHarness('ALLOW');
  h.decide('K2', '/page');
  h.decide('K2', '/page');
  assert.equal(h.state.networkCalls, 2);
});

test('DC-RULE: a rule DENY requested twice reports the violation twice, with 0 network calls and cache size 0', () => {
  const cache = dc.createDecisionCache({ now: () => 1000 });
  assert.equal(cache.set('K3', { conclusion: 'DENY', origin: 'rule' }), false);
  const h = makeHarness('DENY');
  h.decide('K3', '/.env');
  h.decide('K3', '/.env');
  assert.equal(h.state.violations, 2);
  assert.equal(h.state.networkCalls, 0);
  assert.equal(h.cache.size, 0);
});

test('DC-EVICT: 10,001 inserts cap the cache at 10,000 with the oldest key evicted and the newest present', () => {
  const cache = dc.createDecisionCache({ now: () => 5000 });
  for (let i = 0; i <= 10000; i++) cache.set(`key${i}`, { conclusion: 'DENY', origin: 'network' });
  assert.equal(cache.size, 10000);
  assert.equal(cache.get('key0'), undefined);
  assert.ok(cache.get('key10000') !== undefined);
});
