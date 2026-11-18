const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test('RSP-09 version.php and readme.html agree on 5.8.1', () => {
  assert.ok(sdk.rspFingerprintBait('/wp-includes/version.php').includes('5.8.1'));
  assert.ok(sdk.rspFingerprintBait('/readme.html').includes('Version 5.8.1'));
});

test('RSP-09 known slugs 35/35 exact name and Stable tag', () => {
  assert.equal(sdk.RSP_KNOWN_PLUGINS.length, 35);
  let ok = 0;
  for (const [slug, name, version] of sdk.RSP_KNOWN_PLUGINS) {
    const body = sdk.rspFingerprintBait(`/wp-content/plugins/${slug}/readme.txt`);
    if (body && body.includes(`=== ${name} ===`) && body.includes(`Stable tag: ${version}`)) ok++;
  }
  assert.equal(ok, 35);
});

test('RSP-09 unknown slugs 32/32 return the 1.0.2 default, never 404', () => {
  const rng = mulberry32(20320110);
  const known = new Set(sdk.RSP_KNOWN_PLUGINS.map(([s]) => s));
  let ok = 0;
  for (let i = 0; i < 32; i++) {
    const len = 5 + Math.floor(rng() * 10);
    let slug = '';
    for (let j = 0; j < len; j++) slug += 'abcdefghijklmnopqrstuvwxyz'[Math.floor(rng() * 26)];
    if (known.has(slug)) { ok++; continue; }
    const body = sdk.rspFingerprintBait(`/wp-content/plugins/${slug}/readme.txt`);
    if (body && body.includes('Stable tag: 1.0.2')) ok++;
  }
  assert.equal(ok, 32);
});

test('RSP-09 slug guard 6/6 and theme version line', () => {
  const bad = ['../secret', 'a/b', '<b>x</b>', 'has space', '', '.'];
  let blocked = 0;
  for (const slug of bad) if (sdk.rspFingerprintBait(`/wp-content/plugins/${slug}/readme.txt`) === null) blocked++;
  assert.equal(blocked, 6);
  const theme = sdk.rspFingerprintBait('/wp-content/themes/twentytwenty/style.css');
  assert.ok(/^Version: 1\.4$/m.test(theme));
});
