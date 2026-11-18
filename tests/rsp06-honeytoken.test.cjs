const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const SECRET = 'rsp06-test-secret';

function ips(n) { return Array.from({ length: n }, (_, i) => `10.${(i >> 8) & 255}.${i & 255}.7`); }

test('RSP-06 determinism and per-path distinctness', () => {
  const p = sdk.createRspHoneytokenPlants({ secret: SECRET });
  for (const ip of ips(64)) assert.equal(p.plantCredential(ip, '/.env', 'fk'), p.plantCredential(ip, '/.env', 'fk'));
  const variants = ['/.env', '/.env.local', '/.env.production'].map((x) => p.serve(ips(1)[0], x).password);
  assert.equal(new Set(variants).size, 3);
});

test('RSP-06 512 IPs give 512 distinct passwords and 512 distinct AKIA ids', () => {
  const p = sdk.createRspHoneytokenPlants({ secret: SECRET });
  const list = ips(512);
  const pw = list.map((ip) => p.serve(ip, '/.env').password);
  assert.equal(new Set(pw).size, 512);
  const akia = list.map((ip) => p.plantAwsId(ip, '/.aws/credentials'));
  assert.equal(new Set(akia).size, 512);
  assert.ok(akia.every((a) => a.startsWith('AKIA') && a.length === 20));
});

test('RSP-06 correlation 512/512 exact and no plant writes into submitted columns', () => {
  const p = sdk.createRspHoneytokenPlants({ secret: SECRET });
  const list = ips(512);
  const pw = list.map((ip) => p.serve(ip, '/.env').password);
  let ok = 0;
  for (let i = 0; i < 512; i++) { const row = p.present('db_user', pw[i]); if (row && row.ip === list[i] && row.path === '/.env') ok++; }
  assert.equal(ok, 512);
  for (const e of p.plantEvents()) { assert.equal(e.kind, 'plant'); assert.ok(!('submittedPass' in e)); assert.ok(e.plantedPass.length > 0); }
});

test('RSP-06 placeholder variants plant nothing', () => {
  const p = sdk.createRspHoneytokenPlants({ secret: SECRET });
  assert.equal(p.serve('10.0.0.1', '/.env.example').password, '');
  assert.equal(p.serve('10.0.0.1', '/.env.sample').planted, false);
  assert.equal(p.plantEvents().length, 0);
});
