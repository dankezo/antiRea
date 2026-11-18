'use strict';
// WDN-02 site honeytoken HMAC path - suite version of wdn-lab/wdn02.cjs.
// Frozen lab properties (REGISTRATION-WDN-STEP0.md): derivation is
// stateless and deterministic, rotation and secret change both change
// the path, grace is EXACTLY one day, and arming is set membership so a
// random never-derived path is never armed (FP nil by construction).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hm = require('../dist/tier2-active/honeypot-middleware.js');

const DAY_MS = 86400000;
const D0 = Date.UTC(2026, 0, 15, 12, 0, 0); // frozen scenario day D, midday UTC
const S1 = 'wdn02-test-secret-one';
const S2 = 'wdn02-test-secret-two';

const siteAt = (secret, nowMs, extra = {}) =>
  hm.createHoneytokenSite({ secret, enabled: true, now: () => nowMs, ...extra });

test('DERIVE-DET: same secret and day derive the same path twice, in the frozen form', () => {
  const a = siteAt(S1, D0);
  const b = siteAt(S1, D0);
  const pathA = a.activePaths(D0)[0];
  assert.equal(pathA, b.activePaths(D0)[0]);
  assert.match(pathA, /^\/__wd\/[0-9a-f]{12}$/);
  assert.equal(pathA, hm.deriveHoneytokenPath(S1, 'day:2026-01-15'));
});

test('ROTATE-DIFF: the next day derives a different path, and a different secret derives a different path on day D', () => {
  const dayD = siteAt(S1, D0).activePaths(D0)[0];
  const dayD1 = siteAt(S1, D0 + DAY_MS).activePaths(D0 + DAY_MS)[0];
  const otherSecret = siteAt(S2, D0).activePaths(D0)[0];
  assert.notEqual(dayD, dayD1);
  assert.notEqual(dayD, otherSecret);
});

test('GRACE-1DAY exact: day D path is armed on D+1 and NOT armed on D+2; active set at D is today plus yesterday', () => {
  const site = siteAt(S1, D0);
  const pathD = site.activePaths(D0)[0];
  assert.equal(site.activePaths(D0).length, 2);
  assert.equal(site.isArmed(pathD, D0 + DAY_MS), true);
  assert.equal(site.isArmed(pathD, D0 + 2 * DAY_MS), false);
});

test('SECRET-BIND: after a secret change the old path is not armed', () => {
  const pathD = siteAt(S1, D0).activePaths(D0)[0];
  assert.equal(siteAt(S2, D0).isArmed(pathD, D0), false);
});

test('NO-PATTERN-ARM: a random 12-hex path that was never derived is not armed', () => {
  const site = siteAt(S1, D0);
  const derived = new Set(site.activePaths(D0));
  let candidate = '/__wd/000000000000';
  if (derived.has(candidate)) candidate = '/__wd/111111111111';
  assert.equal(site.isArmed(candidate, D0), false);
});

test('stable form: the non-rotating derivation is identical on D and D+2', () => {
  const stable = siteAt(S1, D0, { rotate: false });
  assert.deepEqual(stable.activePaths(D0), stable.activePaths(D0 + 2 * DAY_MS));
  assert.equal(stable.activePaths(D0)[0], hm.deriveHoneytokenPath(S1, 'stable'));
});

test('handle: an armed hit alerts and answers 404; a non-armed path is not trapped; disabled site is inert', async () => {
  const alerts = [];
  const site = hm.createHoneytokenSite({
    secret: S1,
    enabled: true,
    now: () => D0,
    onAlert: (a) => { alerts.push(a); },
  });
  const armedPath = site.activePaths(D0)[0];
  const req = (url) => ({ url, method: 'GET', headers: { get: () => null } });
  const hit = await site.handle(req(armedPath));
  assert.equal(hit.isTrapped, true);
  assert.equal(hit.status, 404);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].path, armedPath);
  const miss = await site.handle(req('/some/real/page'));
  assert.equal(miss.isTrapped, false);
  assert.equal(alerts.length, 1);
  const disabled = hm.createHoneytokenSite({ secret: S1, now: () => D0 });
  const off = await disabled.handle(req(armedPath));
  assert.equal(off.isTrapped, false);
});

test('a missing or empty secret is refused at construction', () => {
  assert.throws(() => hm.createHoneytokenSite({ secret: '' }), /secret/);
  assert.throws(() => hm.createHoneytokenSite({}), /secret/);
});
