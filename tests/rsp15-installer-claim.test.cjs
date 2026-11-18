const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-15 setup form carries 5 core fields, install form 2 core fields', () => {
  const inst = sdk.createRspInstaller();
  assert.equal(inst.setupFormFields().length, 5);
  assert.equal(inst.installFormFields().length, 2);
});

test('RSP-15 20/20 seeded kit runs complete setup, claim, immediate verify grant', () => {
  const inst = sdk.createRspInstaller();
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    const r = inst.claim(`kit${i}`, `pass${i}`);
    if (r.page === 'success' && r.registered && inst.verify(`kit${i}`, `pass${i}`)) ok++;
  }
  assert.equal(ok, 20);
});

test('RSP-15 poison guard 3/3: empty user/password still serve Success, 0 registry rows', () => {
  const inst = sdk.createRspInstaller();
  for (const [u, p] of [['', 'x'], ['u', ''], ['', '']]) {
    const r = inst.claim(u, p);
    assert.equal(r.page, 'success');
    assert.equal(r.registered, false);
  }
  assert.equal(inst.registrySize(), 0);
});
