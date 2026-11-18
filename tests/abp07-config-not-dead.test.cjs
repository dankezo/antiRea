const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
// ABP-07 TRAP-CONFIG-MUST-NOT-BE-DEAD: in the neighbour, the
// documented trapPatterns option occurred exactly once in the whole
// clone (its declaration) and was never read - detection was entirely
// caller-side, so configuring it changed nothing. antiRea form: a
// conformance test over the shipped config surface. Every documented
// option of the audited option interfaces must have a reader in its
// own module: at least one occurrence beyond the declaration (a
// property access, a destructure, a spread into a call), or the
// option must be consumed wholesale through a named shared helper
// (the clock pair now/monoNow, read by resolveIntervalClock when the
// whole options object is passed to it).
const SRC = join(__dirname, '..', 'src', 'tier2-active');

const SURFACES = [
  { file: 'quota-guard.ts', interfaces: ['QuotaGuardOptions'] },
  { file: 'record-budget.ts', interfaces: ['RecordBudgetOptions', 'RecordBudgetIdentityOptions'] },
  { file: 'honeypot-middleware.ts', interfaces: ['CanaryOptions', 'CanaryMazeOptions'] },
  { file: 'decoy-mirage.ts', interfaces: ['DecoyMirageOptions'] },
  { file: 'fake-endpoints.ts', interfaces: ['FakeEndpointsOptions'] },
  { file: 'step-up-402.ts', interfaces: ['StepUp402Options'] },
  { file: 'step-up-proof.ts', interfaces: ['IssueStepUpProofInput', 'CreateStepUpProofVerifierOptions', 'StepUpProofContext'] },
  { file: 'enforcement-tiering.ts', interfaces: ['EnforcementContext', 'HerdResponseConfig'] },
];

function interfaceFields(source, name) {
  const start = source.indexOf('interface ' + name);
  assert.notEqual(start, -1, 'interface not found: ' + name);
  const open = source.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  const body = source.slice(open + 1, end);
  const fields = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^\s{2}(\w+)\??:/);
    if (m) fields.push(m[1]);
  }
  return fields;
}

function countWord(source, word) {
  return (source.match(new RegExp('\\b' + word + '\\b', 'g')) || []).length;
}

for (const surface of SURFACES) {
  const source = readFileSync(join(SRC, surface.file), 'utf8');
  for (const iface of surface.interfaces) {
    test(`ABP-07 ${surface.file} ${iface}: every documented option has a reader`, () => {
      const fields = interfaceFields(source, iface);
      assert.ok(fields.length > 0, iface + ' declares no fields (extraction failed)');
      const dead = [];
      for (const field of fields) {
        const occurrences = countWord(source, field);
        if (occurrences >= 2) continue; // declaration + at least one reader
        // Wholesale consumption: the clock pair is read by
        // resolveIntervalClock(options) in src/internal/mono-clock.ts.
        const clockPair = field === 'now' || field === 'monoNow';
        const wholesale = /resolveIntervalClock\((options|opts)\)/.test(source);
        if (clockPair && wholesale) continue;
        dead.push(field + ' (occurrences: ' + occurrences + ')');
      }
      assert.deepEqual(dead, [], 'dead config options in ' + iface + ': ' + dead.join(', '));
    });
  }
}

test('ABP-07 fixture: the neighbour failure shape is detectable by this method', () => {
  // A declaration-only option (the trapPatterns shape: 1 occurrence)
  // must be reported dead by the same counting rule used above.
  const fixture = 'interface X { trapPatterns?: string[]; }\nconst y = 1;\n';
  assert.equal(countWord(fixture, 'trapPatterns'), 1);
  const withReader = fixture + '\nif (opts.trapPatterns) run();\n';
  assert.ok(countWord(withReader, 'trapPatterns') >= 2);
});

test('ABP-07 behavioural: configuring a canary path actually changes detection', () => {
  // The static rule is backed by one live check per family shape:
  // a configured option must change observable behaviour.
  const sdk = require('../dist/index.js');
  return (async () => {
    const req = (url) => ({ url, headers: { get: () => null } });
    const unconfigured = await sdk.handleCanaryTrapRequest(req('/secret-trap'), {});
    assert.equal(unconfigured.isTrapped, false);
    const configured = await sdk.handleCanaryTrapRequest(req('/secret-trap'), { paths: ['/secret-trap'] });
    assert.equal(configured.isTrapped, true);
  })();
});
