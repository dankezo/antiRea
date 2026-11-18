const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

test('RSP-02 grant matrix 8/8 exact', () => {
  const matrix = [
    [true, 'install', false, true], [true, 'install', true, true],
    [true, 'login', true, false], [true, 'env', true, false],
    [true, null, true, true], [true, null, false, false],
    [false, 'install', true, false], [false, null, true, false],
  ];
  for (const [h, o, t, exp] of matrix) assert.equal(sdk.rspDecideGrant(h, o, t), exp);
});

test('RSP-02 write-once 20/20 ordered origin pairs', () => {
  const origins = ['login', 'env', 'install', 'secret', 'ajax'];
  let ok = 0;
  for (const o1 of origins) for (const o2 of origins) {
    if (o1 === o2) continue;
    const reg = sdk.createRspOriginMatrix();
    reg.record('u', 'p', o1); reg.record('u', 'p', o2);
    const row = reg.row('u', 'p');
    if (row.origin === o1 && row.grantCount === 2) ok++;
  }
  assert.equal(ok, 20);
});

test('RSP-02 instant grant for install/ajax 40/40', () => {
  let ok = 0;
  for (const o of ['install', 'ajax']) for (let i = 0; i < 20; i++) {
    const reg = sdk.createRspOriginMatrix();
    reg.record(`u${i}`, `p${i}`, o);
    if (sdk.rspDecideGrant(true, reg.originOf(`u${i}`, `p${i}`), false)) ok++;
  }
  assert.equal(ok, 40);
});

test('RSP-02 race cost: trap records first, kit login withheld (seeded interleavings)', () => {
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const rng = mulberry32(20320103);
  const lowTrust = ['login', 'env', 'secret'];
  let withheld = 0;
  for (let i = 0; i < 200; i++) {
    const reg = sdk.createRspOriginMatrix();
    const first = lowTrust[Math.floor(rng() * 3)];
    const creator = rng() < 0.5 ? 'install' : 'ajax';
    reg.record('kituser', 'kitpass', first);
    reg.record('kituser', 'kitpass', creator);
    if (!sdk.rspDecideGrant(true, reg.originOf('kituser', 'kitpass'), false)) withheld++;
  }
  assert.equal(withheld, 200);
});
