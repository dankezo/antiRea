'use strict';
// NHS-12 scanner-path prefix matching - suite version of
// nhs-lab/nhs12.cjs, against the advisory counting surface added to
// honeypot-middleware.ts (the chosen form of the NHS-12 / ABE-02
// pair). Frozen expectations: 8/8 match rows, 0/4 near-miss.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hm = require('../dist/tier2-active/honeypot-middleware.js');

const MATCH = ['/.env', '/.git/config', '/WP-LOGIN', '/wp-admin/users', '/.aws/credentials', '/phpinfo.php', '/.env.bak', '/.env?x=1'];
const MISS = ['/x/.env', '/environment', '/', '/about'];

test('8/8 match rows: six prefixes incl. uppercase /WP-LOGIN, query-stripped /.env', () => {
  for (const p of MATCH) assert.equal(hm.isScannerPath(p), true, p);
  assert.equal(hm.matchScannerPathPrefix('/WP-LOGIN'), '/wp-login');
  assert.equal(hm.matchScannerPathPrefix('/.env?x=1'), '/.env');
  assert.equal(hm.matchScannerPathPrefix('/.env.bak'), '/.env', 'prefix breadth is the measured behaviour');
});

test('0/4 near-miss rows: not anchored, no dot, root and ordinary paths miss', () => {
  for (const p of MISS) assert.equal(hm.isScannerPath(p), false, p);
});

test('counter counts hits only, per prefix, and enforces nothing', () => {
  const c = hm.createScannerPathCounter();
  for (const p of [...MATCH, ...MISS]) c.observe(p);
  assert.equal(c.total(), 8);
  const by = c.byPrefix();
  assert.equal(by['/.env'], 3); // /.env, /.env.bak, /.env?x=1
  assert.equal(by['/wp-login'], 1);
  const one = c.observe('/about');
  assert.equal(one.matched, false);
  assert.equal(one.enforcement, 'none');
  assert.deepEqual([...hm.SCANNER_PATH_PREFIXES], ['/.env', '/.git', '/wp-login', '/wp-admin', '/.aws', '/phpinfo']);
});
