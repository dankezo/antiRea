'use strict';
// NHS-15 allowlist CIDR short-circuit - suite version of
// nhs-lab/nhs15.cjs. Highest blast radius class: built behind
// explicit opt-in (constructing the scorer with a list), with the
// measured interaction encoded exactly - above all, a feed ban
// still wins over the allowlist, scoring exactly 100.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const al = require('../dist/tier2-active/allowlist-scoring.js');

const AL = ['198.51.100.0/24'];
const scorer = () => al.createAllowlistScorer({ allowlist: AL });

test('allowlisted IPs score 0, including both CIDR edge addresses', () => {
  const s = scorer();
  assert.equal(s.score({ ip: '198.51.100.10', bot: true }).score, 0);
  assert.equal(s.score({ ip: '198.51.100.20', bot: true }).score, 0);
  assert.equal(s.score({ ip: '198.51.100.0', bot: true }).score, 0, 'first address');
  assert.equal(s.score({ ip: '198.51.100.255', bot: true }).score, 0, 'last address');
  assert.equal(s.score({ ip: '198.51.100.10', bot: true }).shortCircuit, 'allowlist');
});

test('BAN WINS: allowlist + CrowdSec ban scores exactly 100', () => {
  const s = scorer();
  const r = s.score({ ip: '198.51.100.10', bot: false, crowdsec: 'ban' });
  assert.equal(r.score, 100);
  assert.equal(r.shortCircuit, null);
  assert.equal(r.crowdsecOverrides, true);
  assert.equal(r.allowlisted, true, 'the IP is allowlisted - and the ban still wins');
});

test('outside and one-bit-outside score the normal bot weight 30', () => {
  const s = scorer();
  assert.equal(s.score({ ip: '203.0.113.5', bot: true }).score, 30);
  assert.equal(s.score({ ip: '198.51.101.1', bot: true }).score, 30);
});

test('empty allowlist zeroes nothing', () => {
  const s = al.createAllowlistScorer({ allowlist: [] });
  assert.equal(s.score({ ip: '198.51.100.10', bot: true }).score, 30);
});

test('tier arithmetic outside the allowlist: captcha 40, throttle 65, ban 100', () => {
  const s = scorer();
  assert.equal(s.score({ ip: '203.0.113.5', crowdsec: 'captcha' }).score, 40);
  assert.equal(s.score({ ip: '203.0.113.5', crowdsec: 'throttle' }).score, 65);
  assert.equal(s.score({ ip: '203.0.113.5', crowdsec: 'ban' }).score, 100);
  assert.equal(s.score({ ip: '203.0.113.5', bot: true, crowdsec: 'ban' }).score, 130, 'the weighted sum, pinned so it is never a surprise');
});

test('known-good lane: scores 0 unless a CrowdSec hit or an FCrDNS spoof disables it', () => {
  const s = scorer();
  assert.equal(s.score({ ip: '203.0.113.5', bot: true, knownGood: true }).shortCircuit, 'known_good');
  assert.equal(s.score({ ip: '203.0.113.5', bot: true, knownGood: true }).score, 0);
  assert.equal(s.score({ ip: '203.0.113.5', bot: true, knownGood: true, fcrdnsSpoofed: true }).score, 30, 'spoofed disables the known-good short-circuit');
  assert.equal(s.score({ ip: '203.0.113.5', knownGood: true, crowdsec: 'ban' }).score, 100, 'a hit disables it too');
});

test('invalid CIDR entries throw at construction - no silent widening of the exemption', () => {
  assert.throws(() => al.createAllowlistScorer({ allowlist: ['198.51.100.0/33'] }), TypeError);
  assert.throws(() => al.createAllowlistScorer({ allowlist: ['not-a-cidr'] }), TypeError);
});
