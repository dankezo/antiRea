const { test } = require('node:test');
const assert = require('node:assert/strict');
// ABP-02 TRAP-PATHS-MUST-NOT-BE-PUBLIC-IN-PAGE-SOURCE: in the
// neighbour, all 3 default trap paths appeared verbatim in the
// served script and the trap container's hiding markers were
// constant (1px / clip-path inset(50%) / z-index -9999, plus
// aria-hidden / nofollow / tabindex). antiRea form: hygiene rules
// (auditTrapHygiene) over page source, plus pins that the shipped
// decoy surfaces themselves pass the audit.
const sdk = require('../dist/index.js');

const NEIGHBOUR_PATHS = ['/wp-login.php', '/.env', '/admin/login'];

// The lab fixture shape, rebuilt from the measured properties:
// 3 default paths verbatim in the served script; container markers
// constant.
const NEIGHBOUR_PAGE = [
  '<html><head><script>',
  'var traps = ["/wp-login.php", "/.env", "/admin/login"];',
  '</script></head><body>',
  '<div aria-hidden="true" style="width:1px;height:1px;clip-path:inset(50%);z-index:-9999">',
  '<a href="/.env" rel="nofollow" tabindex="-1">x</a></div>',
  '</body></html>',
].join('\n');

test('neighbour fixture violates all three hygiene rules', () => {
  const result = sdk.auditTrapHygiene(NEIGHBOUR_PAGE, NEIGHBOUR_PATHS);
  assert.equal(result.ok, false);
  const rules = result.violations.map(v => v.rule);
  assert.ok(rules.includes('trap_path_in_script'), rules.join(','));
  assert.ok(rules.includes('trap_paths_enumerated'), rules.join(','));
  assert.ok(rules.includes('constant_hiding_markers'), rules.join(','));
  // One script violation per leaked path (3 paths in the script).
  assert.equal(result.violations.filter(v => v.rule === 'trap_path_in_script').length, 3);
});

test('a page with no trap content passes trivially', () => {
  const result = sdk.auditTrapHygiene('<html><body><p>hello</p></body></html>', NEIGHBOUR_PATHS);
  assert.deepEqual(result, { ok: true, violations: [] });
});

test('a single bait anchor outside a script passes (the sanctioned appearance)', () => {
  const html = '<html><body>' + sdk.canaryTrapLink('/_canary/') + '</body></html>';
  const result = sdk.auditTrapHygiene(html, ['/_canary/', '/api/v1/internal/schema-export']);
  assert.equal(result.ok, true, JSON.stringify(result.violations));
});

test('two distinct trap paths in one page are an enumeration violation even without a script', () => {
  const html = '<a href="/.env">a</a><a href="/wp-login.php">b</a>';
  const result = sdk.auditTrapHygiene(html, NEIGHBOUR_PATHS);
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map(v => v.rule), ['trap_paths_enumerated']);
});

test('one constant marker alone is ordinary CSS; the combination is the fingerprint', () => {
  const single = sdk.auditTrapHygiene('<div style="display:none">x</div>', NEIGHBOUR_PATHS);
  assert.equal(single.ok, true);
  const combo = sdk.auditTrapHygiene('<div style="width: 1px; clip-path: inset(50%)">x</div>', NEIGHBOUR_PATHS);
  assert.equal(combo.ok, false);
  assert.equal(combo.violations[0].rule, 'constant_hiding_markers');
});

test('shipped fake-endpoint bodies pass the hygiene audit', async () => {
  const pack = sdk.createFakeEndpoints({ enabled: true, echoSecret: 'abp02-secret' });
  const req = (url) => ({ url, headers: { get: () => null } });
  for (const path of pack.paths) {
    const res = await pack.handle(req(path));
    assert.equal(res.isDecoy, true, path);
    const audit = sdk.auditTrapHygiene(res.body, [...sdk.FAKE_ENDPOINT_PATHS, ...sdk.CANARY_ENDPOINTS]);
    assert.equal(audit.ok, true, path + ': ' + JSON.stringify(audit.violations));
  }
});

test('shipped decoy-mirage documents contain no trap path enumeration', async () => {
  const mirage = sdk.createDecoyMirage({});
  const req = (url) => ({ url, headers: { get: () => null } });
  for (const path of sdk.CANARY_ENDPOINTS) {
    const res = await mirage.handle(req(path));
    assert.equal(res.isDecoy, true, path);
    const audit = sdk.auditTrapHygiene(JSON.stringify(res.body), [...sdk.CANARY_ENDPOINTS, ...sdk.FAKE_ENDPOINT_PATHS]);
    assert.equal(audit.ok, true, path + ': ' + JSON.stringify(audit.violations));
  }
});

test('shipped canary maze pages pass the hygiene audit', async () => {
  const maze = sdk.createCanaryMaze({ enabled: true });
  const req = (url) => ({ url, headers: { get: () => null } });
  const res = await maze.handle(req('/_canary/'));
  assert.equal(res.isTrapped, true);
  const audit = sdk.auditTrapHygiene(res.html, [...sdk.CANARY_ENDPOINTS, ...sdk.FAKE_ENDPOINT_PATHS]);
  assert.equal(audit.ok, true, JSON.stringify(audit.violations));
});
