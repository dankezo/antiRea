const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const SECRET = 'rsp01-test-secret';

test('RSP-01 construction is impossible without a honeypot pack token', () => {
  assert.throws(() => sdk.createRspThresholdPin(null, { secret: SECRET }), /honeypot pack/);
  assert.throws(() => sdk.createRspThresholdPin({ kind: 'rsp-honeypot-pack' }, { secret: SECRET }), /honeypot pack/);
  assert.throws(() => sdk.createRspThresholdPin('honeypot', { secret: SECRET }), /honeypot pack/);
  const pack = sdk.createRspHoneypotPack();
  assert.equal(sdk.isRspHoneypotPack(pack), true);
  assert.equal(sdk.isRspHoneypotPack({ kind: 'rsp-honeypot-pack' }), false);
  assert.ok(sdk.createRspThresholdPin(pack, { secret: SECRET }));
});

test('RSP-01 PIN-EXACT 64/64: grant lands exactly at the derived threshold', () => {
  const gate = sdk.createRspThresholdPin(sdk.createRspHoneypotPack(), { secret: SECRET });
  for (let i = 0; i < 64; i++) {
    const ip = `10.1.${i}.9`;
    const t = gate.thresholdFor(ip);
    assert.ok(t >= 10 && t <= 100);
    let grantAt = -1;
    for (let a = 1; a <= t; a++) {
      const r = gate.present(ip, `u${a}`, `p${a}`);
      if (r.granted) { grantAt = a; break; }
    }
    assert.equal(grantAt, t, `ip ${ip} must grant exactly at threshold ${t}`);
  }
});

test('RSP-01 pinned counter: 200 presentations of the granted pair give 0 grants, 0 resets', () => {
  const gate = sdk.createRspThresholdPin(sdk.createRspHoneypotPack(), { secret: SECRET });
  const ip = '10.2.0.9';
  const t = gate.thresholdFor(ip);
  let grantedPair = null;
  for (let a = 1; a <= t; a++) { const r = gate.present(ip, `u${a}`, `p${a}`); if (r.granted) grantedPair = [`u${a}`, `p${a}`]; }
  assert.ok(grantedPair);
  const pinnedCount = gate.attemptsFor(ip);
  let grants = 0;
  for (let i = 0; i < 200; i++) if (gate.present(ip, grantedPair[0], grantedPair[1]).granted) grants++;
  assert.equal(grants, 0);
  assert.equal(gate.attemptsFor(ip), pinnedCount, 'counter must not reset while pinned');
  const next = gate.present(ip, 'fresh-user', 'fresh-pass');
  assert.equal(next.granted, true);
  assert.equal(gate.attemptsFor(ip), 0);
});
