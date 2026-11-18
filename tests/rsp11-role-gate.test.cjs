const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const CREDS = 'user_login=kitadmin&user_pass=Str0ng%21';

test('RSP-11 positives 6/6 and case forms 2/2', () => {
  const positives = [
    `${CREDS}&role=administrator`, `${CREDS}&role=admin`, `${CREDS}&role=editor`,
    `${CREDS}&role=level_10`, `${CREDS}&user_role=administrator`, `${CREDS}&new_role=editor`,
  ];
  assert.equal(positives.filter((b) => sdk.rspRoleGate(b).registered).length, 6);
  const cases = [`${CREDS}&role=Administrator`, `${CREDS}&role=ADMINISTRATOR`];
  assert.equal(cases.filter((b) => sdk.rspRoleGate(b).registered).length, 2);
});

test('RSP-11 serialized wp_capabilities containing administrator is caught', () => {
  const body = `${CREDS}&wp_capabilities=${encodeURIComponent('a:1:{s:13:"administrator";b:1;}')}`;
  assert.equal(sdk.rspRoleGate(body).registered, true);
});

test('RSP-11 negatives 4/4; no-role pair is captured but not registered', () => {
  const negatives = [CREDS, `${CREDS}&role=subscriber`, `${CREDS}&role=`, 'user_login=kitadmin&role=administrator'];
  assert.equal(negatives.filter((b) => !sdk.rspRoleGate(b).registered).length, 4);
  const plain = sdk.rspRoleGate(CREDS);
  assert.equal(plain.captured, true);
  assert.equal(plain.registered, false);
  assert.equal(plain.user, 'kitadmin');
});

test('RSP-11 documented gap: the same escalation as JSON registers 0', () => {
  const json = JSON.stringify({ user_login: 'kitadmin', user_pass: 'Str0ng!', role: 'administrator' });
  assert.equal(sdk.rspRoleGate(json).registered, false);
});
