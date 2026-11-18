'use strict';
// WDN-08 test-trigger reserved UA - suite version of wdn-lab/wdn08.cjs.
// Frozen lab properties: prefix-anchored (an embedded occurrence does
// NOT trigger), case-insensitive, browser UA does not trigger, and on
// the tripwire path there are 0 rule evaluations, 0 violations and an
// unchanged stats accumulator.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const tt = require('../dist/tier2-active/wdn-test-trigger.js');

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// A minimal instrumented pipeline standing in for a host decide():
// one tripwire rule (DENY on /.env) plus a stats counter that counts
// every non-test decision, exactly as the lab model does.
function makePipeline(guard) {
  const state = { ruleEvaluations: 0, violations: 0, statsCount: 0 };
  function decide(ua, path) {
    return guard.guard(ua, () => {
      state.ruleEvaluations++;
      if (path === '/.env') {
        state.violations++;
        state.statsCount++;
        return { kind: 'normal', conclusion: 'DENY' };
      }
      state.statsCount++;
      return { kind: 'normal', conclusion: 'ALLOW' };
    });
  }
  return { state, decide };
}

test('TT-LABEL: the reserved UA produces the labelled test decision with the honest no-key error and zero rule evaluations', () => {
  const { state, decide } = makePipeline(tt.createTestTriggerGuard());
  const d = decide('WebDecoy-Test/1.0', '/');
  assert.equal(d.kind, 'test_trigger');
  assert.equal(d.isTestTrigger, true);
  assert.equal(d.botDetected, true);
  assert.equal(d.botType, 'test_trigger');
  assert.equal(d.ruleEnforced, false);
  assert.equal(d.conclusion, 'DENY');
  assert.ok(typeof d.error === 'string' && d.error.includes('no apiKey is configured'));
  assert.equal(state.ruleEvaluations, 0);
  assert.equal(state.statsCount, 0);
});

test('TT-CASE: the lowercase form triggers', () => {
  assert.equal(tt.isTestTriggerUserAgent('webdecoy-test/1.0'), true);
  const { decide } = makePipeline(tt.createTestTriggerGuard());
  assert.equal(decide('webdecoy-test/1.0', '/').kind, 'test_trigger');
});

test('TT-ANCHOR: an embedded occurrence does NOT trigger and the normal pipeline runs', () => {
  assert.equal(tt.isTestTriggerUserAgent('Mozilla/5.0 WebDecoy-Test/1.0'), false);
  const { state, decide } = makePipeline(tt.createTestTriggerGuard());
  const d = decide('Mozilla/5.0 WebDecoy-Test/1.0', '/');
  assert.equal(d.kind, 'normal');
  assert.equal(state.ruleEvaluations, 1);
});

test('TT-BROWSER: a Chrome UA does not trigger', () => {
  assert.equal(tt.isTestTriggerUserAgent(CHROME), false);
  assert.equal(tt.checkTestTrigger(CHROME), null);
});

test('TT-NORULES and TT-EXCLUDED: the test UA on the tripwire path fires no rule, records no violation, leaves stats unchanged', () => {
  const { state, decide } = makePipeline(tt.createTestTriggerGuard());
  decide(CHROME, '/'); // one normal decision so the counters are non-trivial
  const before = { ...state };
  const d = decide('WebDecoy-Test/1.0', '/.env');
  assert.equal(d.kind, 'test_trigger');
  assert.equal(state.ruleEvaluations, before.ruleEvaluations);
  assert.equal(state.violations, before.violations);
  assert.equal(state.statsCount, before.statsCount);
});

test('descriptive: a UA with leading spaces triggers (trimStart)', () => {
  assert.equal(tt.isTestTriggerUserAgent('  WebDecoy-Test/1.0'), true);
});

test('empty and missing UAs never trigger; a configured apiKey drops the error note', () => {
  assert.equal(tt.isTestTriggerUserAgent(''), false);
  assert.equal(tt.isTestTriggerUserAgent(null), false);
  assert.equal(tt.isTestTriggerUserAgent(undefined), false);
  const d = tt.createTestTriggerDecision({ apiKeyConfigured: true });
  assert.equal(d.error, undefined);
});
