const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

/** The reconstruction-study agent workflow, as observed in the server logs. */
const runAgentSequence = (scorer, key) => {
  scorer.observe(key, { routeClass: 'auth', status: 200 });
  scorer.observe(key, { routeClass: 'list', status: 429, pageSizeRequested: 500 }); // boundary probe
  for (let page = 0; page < 5; page++) {
    scorer.observe(key, { routeClass: 'list', status: 200, pageSizeRequested: 50, recordsReturned: 50 });
  }
  for (let i = 0; i < 3; i++) scorer.observe(key, { routeClass: 'export', status: 200 });
  scorer.observe(key, { routeClass: 'canary', status: 404 });
};

/** A polite human session: a few details, two partial searches, no rejections. */
const runHumanSequence = (scorer, key) => {
  scorer.observe(key, { routeClass: 'auth', status: 200 });
  scorer.observe(key, { routeClass: 'detail', status: 200 });
  scorer.observe(key, { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 8 });
  scorer.observe(key, { routeClass: 'detail', status: 200 });
  scorer.observe(key, { routeClass: 'detail', status: 200 });
  scorer.observe(key, { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 3 });
};

test('the study agent sequence scores HIGH with the expected reasons', () => {
  const scoreEvents = [];
  const scorer = sdk.createFlowScorer({ onScore: e => scoreEvents.push(e) });
  runAgentSequence(scorer, 'account:agent');
  const final = scorer.score('account:agent');
  assert.ok(final >= 70, `expected a high score, got ${final}`);
  const reasons = scorer.reasons('account:agent');
  for (const expected of ['boundary_probe', 'post_429_persistence', 'sequential_full_coverage', 'export_burst', 'canary_contact']) {
    assert.ok(reasons.some(r => r.includes(expected)), `missing reason ${expected} in ${JSON.stringify(reasons)}`);
  }
  assert.deepEqual(scoreEvents.map(e => e.level), ['elevated', 'high']);
  const high = scoreEvents[1];
  assert.ok(high.reasons.some(r => r.includes('post_429_persistence')));
});

test('a polite human sequence scores zero and emits nothing', () => {
  const scoreEvents = [];
  const taints = [];
  const scorer = sdk.createFlowScorer({ onScore: e => scoreEvents.push(e), onTaint: e => taints.push(e) });
  runHumanSequence(scorer, 'account:human');
  assert.equal(scorer.score('account:human'), 0);
  assert.deepEqual(scorer.reasons('account:human'), []);
  assert.equal(scoreEvents.length, 0);
  assert.equal(taints.length, 0);
});

test('post-429 persistence alone crosses the elevated threshold (strongest single signal)', () => {
  const scoreEvents = [];
  const scorer = sdk.createFlowScorer({ onScore: e => scoreEvents.push(e) });
  scorer.observe('s', { routeClass: 'list', status: 429, pageSizeRequested: 500 }); // probe: +10
  scorer.observe('s', { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 4 }); // persists: +25
  scorer.observe('s', { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 4 }); // persists: +25
  assert.equal(scorer.score('s'), 60);
  assert.equal(scoreEvents.length, 1);
  assert.equal(scoreEvents[0].level, 'elevated');
});

test('crossing high fires onTaint once; further events do not re-fire', () => {
  const taints = [];
  const scorer = sdk.createFlowScorer({ onTaint: e => taints.push(e) });
  runAgentSequence(scorer, 'account:agent');
  const highTaints = taints.filter(t => t.trigger === 'high_threshold');
  assert.equal(highTaints.length, 1);
  scorer.observe('account:agent', { routeClass: 'export', status: 200 });
  scorer.observe('account:agent', { routeClass: 'export', status: 200 });
  assert.equal(taints.filter(t => t.trigger === 'high_threshold').length, 1);
});

test('a decoy hit fires onTaint with trigger decoy_contact exactly once', () => {
  const taints = [];
  const scorer = sdk.createFlowScorer({ onTaint: e => taints.push(e) });
  scorer.observe('s', { routeClass: 'decoy', status: 200 });
  scorer.observe('s', { routeClass: 'decoy', status: 200 });
  assert.equal(taints.length, 1);
  assert.equal(taints[0].trigger, 'decoy_contact');
  assert.equal(scorer.score('s'), 50); // decoy weight equals canary weight, latched once
});

test('exempt identities are never scored and hold no state', () => {
  const scoreEvents = [];
  const taints = [];
  const scorer = sdk.createFlowScorer({
    isExempt: key => key === 'bot:verified-google',
    onScore: e => scoreEvents.push(e),
    onTaint: e => taints.push(e),
  });
  const standing = scorer.observe('bot:verified-google', { routeClass: 'canary', status: 404 });
  assert.equal(standing.exempt, true);
  runAgentSequence(scorer, 'bot:verified-google');
  assert.equal(scorer.score('bot:verified-google'), 0);
  assert.deepEqual(scorer.reasons('bot:verified-google'), []);
  assert.equal(scoreEvents.length, 0);
  assert.equal(taints.length, 0);
});

test('an idle session restarts with clean features after the window', () => {
  let now = 1_000_000;
  const scorer = sdk.createFlowScorer({ windowMs: 60_000, now: () => now });
  scorer.observe('s', { routeClass: 'canary', status: 404 });
  assert.equal(scorer.score('s'), 50);
  now += 61_000;
  assert.equal(scorer.score('s'), 0);
  scorer.observe('s', { routeClass: 'detail', status: 200 });
  assert.equal(scorer.score('s'), 0);
});

test('identical post-429 retries accrue NO persistence (client-library auto-retry), varied attempts do', () => {
  const taints = [];
  const scorer = sdk.createFlowScorer({ onTaint: e => taints.push(e) });
  scorer.observe('s', { routeClass: 'list', status: 429, pageSizeRequested: 500 }); // the rejected attempt
  for (let i = 0; i < 6; i++) {
    scorer.observe('s', { routeClass: 'list', status: 429, pageSizeRequested: 500 }); // identical retries
  }
  // Only boundary-probe points (capped at 30): retries are not persistence.
  assert.equal(scorer.score('s'), 30);
  assert.ok(!scorer.reasons('s').some(r => r.includes('post_429_persistence')));
  assert.equal(taints.length, 0);
  // A DIFFERENT attempt after the 429 is persistence.
  scorer.observe('s', { routeClass: 'export', status: 200 });
  assert.ok(scorer.reasons('s').some(r => r.includes('post_429_persistence')));
  assert.equal(scorer.score('s'), 55);
  // And a list attempt with a changed page size is persistence too.
  scorer.observe('s', { routeClass: 'list', status: 200, pageSizeRequested: 50, recordsReturned: 10 });
  assert.equal(scorer.score('s'), 80);
});

test('ambient decoy hits add a small score and never taint; programmatic hits taint', () => {
  const taints = [];
  const scorer = sdk.createFlowScorer({ onTaint: e => taints.push(e) });
  scorer.observe('account:a', { routeClass: 'decoy', status: 200, hitKind: 'ambient' });
  assert.equal(scorer.score('account:a'), 10);
  scorer.observe('account:a', { routeClass: 'decoy', status: 200, hitKind: 'ambient' });
  assert.equal(scorer.score('account:a'), 20);
  assert.equal(taints.length, 0);
  assert.ok(scorer.reasons('account:a').some(r => r.includes('decoy_contact_ambient')));
  // The same session later fetching programmatically DOES taint (the
  // decoy_contact trigger; the resulting score of 70 also crosses high,
  // which is a second, distinct trigger).
  scorer.observe('account:a', { routeClass: 'decoy', status: 200, hitKind: 'programmatic' });
  assert.equal(taints.filter(t => t.trigger === 'decoy_contact').length, 1);
  assert.equal(taints.filter(t => t.trigger === 'high_threshold').length, 1);

  const other = sdk.createFlowScorer({ onTaint: e => taints.push(e) });
  other.observe('account:b', { routeClass: 'decoy', status: 200, hitKind: 'programmatic' });
  assert.equal(other.score('account:b'), 50);
  assert.equal(taints.filter(t => t.sessionKey === 'account:b').length, 1);
});

test('ip identities are scored but NEVER tainted, even by a programmatic decoy hit or a high score', () => {
  const scoreEvents = [];
  const taints = [];
  const scorer = sdk.createFlowScorer({ onScore: e => scoreEvents.push(e), onTaint: e => taints.push(e) });
  scorer.observe('ip:203.0.113.9', { routeClass: 'decoy', status: 200, hitKind: 'programmatic' });
  assert.equal(scorer.score('ip:203.0.113.9'), 50); // score still accrues
  assert.ok(scoreEvents.some(e => e.level === 'elevated')); // onScore still fires
  assert.equal(taints.length, 0); // but no taint: the IP may be shared
  runAgentSequence(scorer, 'ip:203.0.113.9'); // pushes the same key past high
  assert.ok(scorer.score('ip:203.0.113.9') >= 70);
  assert.equal(taints.length, 0);
});

test('a custom identityKind hook can classify unprefixed keys as ip (no taint)', () => {
  const taints = [];
  const scorer = sdk.createFlowScorer({
    identityKind: key => (key.startsWith('shared-') ? 'ip' : 'account'),
    onTaint: e => taints.push(e),
  });
  scorer.observe('shared-nat-1', { routeClass: 'decoy', status: 200, hitKind: 'programmatic' });
  assert.equal(scorer.score('shared-nat-1'), 50);
  assert.equal(taints.length, 0);
  scorer.observe('user-1', { routeClass: 'decoy', status: 200, hitKind: 'programmatic' });
  assert.equal(taints.length, 1);
});

test('interleaved detail views break the coverage streak', () => {
  const scorer = sdk.createFlowScorer({});
  for (let i = 0; i < 4; i++) {
    scorer.observe('s', { routeClass: 'list', status: 200, pageSizeRequested: 50, recordsReturned: 50 });
    scorer.observe('s', { routeClass: 'detail', status: 200 });
  }
  // Each full page restarted the streak at 1, so no coverage points accrue.
  assert.equal(scorer.score('s'), 0);
});
