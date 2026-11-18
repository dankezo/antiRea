'use strict';
// WDN-09 rule-state taxonomy - suite version of wdn-lab/wdn09.cjs.
// Frozen lab properties: RUN / DRY_RUN / NOT_RUN / CACHED stay distinct;
// a dry-run DENY concludes DENY but does not decide and deniedBy is
// false; missing-input rules report NOT_RUN; cached copies never deny.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rs = require('../dist/tier2-active/wdn-rule-state.js');

test('STATE-RUN: a plain DENY rule is labelled RUN, concludes DENY, decides the engine, and deniedBy is true', () => {
  const raw = { rule: 'plain-deny', action: 'DENY', reason: 'fixture deny' };
  const outcome = rs.toRuleOutcome(raw);
  assert.equal(outcome.state, 'RUN');
  assert.equal(outcome.conclusion, 'DENY');
  assert.equal(rs.decideFromRuleResults([raw]), 'DENY');
  assert.equal(rs.deniedBy({ results: [outcome] }, 'plain-deny'), true);
});

test('STATE-DRYRUN: a dry-run DENY is labelled DRY_RUN with action ALLOW and conclusion DENY; it does not decide and deniedBy is false', () => {
  const raw = { rule: 'tripwire', action: 'ALLOW', reason: 'Tripwire hit (dry run)', metadata: { dryRun: true } };
  const outcome = rs.toRuleOutcome(raw);
  assert.equal(outcome.state, 'DRY_RUN');
  assert.equal(outcome.action, 'ALLOW');
  assert.equal(outcome.conclusion, 'DENY');
  assert.equal(rs.decideFromRuleResults([raw]), 'ALLOW');
  assert.equal(rs.deniedBy({ results: [outcome] }, 'tripwire'), false);
});

test('STATE-NOTRUN: missing-input rules report NOT_RUN, never an empty run, and never decide', () => {
  const filterRaw = { rule: 'filter:ip.country', action: 'ALLOW', state: 'NOT_RUN', reason: 'No IP enrichment available' };
  const rateRaw = { rule: 'rate-limit:10/60s', action: 'ALLOW', state: 'NOT_RUN', reason: 'async store not prepared' };
  assert.equal(rs.toRuleOutcome(filterRaw).state, 'NOT_RUN');
  assert.equal(rs.toRuleOutcome(rateRaw).state, 'NOT_RUN');
  assert.equal(rs.decideFromRuleResults([filterRaw, rateRaw]), 'ALLOW');
});

test('STATE-CACHED: asCached restates every result CACHED and deniedBy on the copy is false', () => {
  const decision = { results: [rs.toRuleOutcome({ rule: 'plain-deny', action: 'DENY' })] };
  const cached = rs.asCachedRuleDecision(decision);
  assert.ok(cached.results.every((r) => r.state === 'CACHED'));
  assert.equal(rs.deniedBy(cached, 'plain-deny'), false);
  // The original decision is untouched.
  assert.equal(decision.results[0].state, 'RUN');
});
