'use strict';
// ABG-03 honey-credential injection - suite version of abg-lab/abg03.cjs.
// Frozen gates (seed 20321203): Y presenting X's key flags on X (the
// OWNER, not the presenter); owner with a valid chal cookie does not
// flag; expired key (2 h TTL) never flags; random key never flags.
// Descriptive arm B2: owner WITHOUT the cookie DOES flag - the guard
// is cookie-based, not ownership-based.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const m = require('../dist/tier2-active/canary-credential.js');

const SECRET = crypto.createHash('sha256').update('abg03-lab:20321203').digest();
const T0 = 1_000_000_000; // ms
const X = 'id-X';
const Y = 'id-Y';
const UA_BROWSER = 'Mozilla/5.0 Chrome/131.0.0.0';
const UA_HTTP = 'python-requests/2.32.3';
const IP_TIER = '203.0.113.0/24';
const JA4 = 't13d1516h2_8daaf6152771_9c8e1f2a3b4c';

function setup() {
  const auth = m.createHoneyCredentialAuthority(SECRET);
  const keyX = auth.issueKey(X, T0);
  return { auth, keyX };
}
const ctx = (auth, ua, cookie) => ({ userAgent: ua, ipTier: IP_TIER, ja4: JA4, ...(cookie ? { cookie } : {}) });
const cookieFor = (auth, ua) => auth.mintCuriosityCookie({ userAgent: ua, ipTier: IP_TIER, ja4: JA4 });

test('ABG-03 gate A: Y presents X key without a cookie - flag lands on the OWNER X, presenter kept separate', () => {
  const { auth, keyX } = setup();
  const r = auth.presentKey({ key: keyX, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP), nowMs: T0 + 10_000 });
  assert.equal(r.status, 200);
  assert.equal(r.flagged, true);
  assert.equal(r.flaggedOwner, X);
  assert.equal(r.keyOwner, X);
  assert.equal(r.presenterIdentity, Y);
  assert.equal(r.enforcement, 'none');
});

test('ABG-03 gate B: owner presenting its own key WITH the natural-flow cookie does not flag', () => {
  const { auth, keyX } = setup();
  const r = auth.presentKey({ key: keyX, presenterIdentity: X, presenter: ctx(auth, UA_BROWSER, cookieFor(auth, UA_BROWSER)), nowMs: T0 + 20_000 });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, 'curiosity_cookie');
  assert.equal(r.status, 200);
});

test('ABG-03 gate C: explicit valid cookie does not flag for any presenter', () => {
  const { auth, keyX } = setup();
  const r = auth.presentKey({ key: keyX, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP, cookieFor(auth, UA_HTTP)), nowMs: T0 + 30_000 });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, 'curiosity_cookie');
});

test('ABG-03 gate D: expired key (presented at t0 + 7201 s) never flags', () => {
  const { auth, keyX } = setup();
  const r = auth.presentKey({ key: keyX, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP), nowMs: T0 + 7_201_000 });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, 'expired_key');
  assert.equal(r.status, 200);
});

test('ABG-03 control (a): a random never-issued 32-hex key never flags', () => {
  const { auth } = setup();
  const randomKey = crypto.createHash('sha256').update('never-issued:20321203').digest('hex').slice(0, 32);
  const r = auth.presentKey({ key: randomKey, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP), nowMs: T0 + 40_000 });
  assert.equal(r.flagged, false);
  assert.equal(r.reason, 'unknown_key');
});

test('ABG-03 control (c): after the owner is flagged, Y presenting again still lands the risk on X', () => {
  const { auth, keyX } = setup();
  auth.presentKey({ key: keyX, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP), nowMs: T0 + 10_000 });
  const r = auth.presentKey({ key: keyX, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP), nowMs: T0 + 60_000 });
  assert.equal(r.flaggedOwner, X);
  assert.equal(r.presenterIdentity, Y);
});

test('ABG-03 descriptive B2: the owner WITHOUT the cookie DOES flag (guard is cookie-based, not ownership-based)', () => {
  const { auth, keyX } = setup();
  const r = auth.presentKey({ key: keyX, presenterIdentity: X, presenter: ctx(auth, UA_BROWSER), nowMs: T0 + 70_000 });
  assert.equal(r.flagged, true);
  assert.equal(r.flaggedOwner, X);
});

test('ABG-03: a cookie minted for a different context does not exempt', () => {
  const { auth, keyX } = setup();
  const foreign = auth.mintCuriosityCookie({ userAgent: UA_BROWSER, ipTier: '198.51.100.0/24', ja4: JA4 });
  const r = auth.presentKey({ key: keyX, presenterIdentity: Y, presenter: ctx(auth, UA_HTTP, foreign), nowMs: T0 + 10_000 });
  assert.equal(r.flagged, true);
});

test('ABG-03: the snippet plants the issued key and keys are deterministic per hour bucket', () => {
  const { auth, keyX } = setup();
  assert.equal(auth.issueKey(X, T0 + 1000), keyX);
  const snippet = auth.honeyCredentialSnippet(X, T0);
  assert.ok(snippet.includes(keyX));
  assert.equal(m.HONEY_CREDENTIAL_TTL_MS, 7_200_000);
});
