const { test } = require('node:test');
const assert = require('node:assert/strict');
// KT-01 EvidentiaryRoles: the role table, the conditional BS-01
// row, the audit invariant (the lab's 10 frozen packs), and the
// K2 decoration over the REAL shipped factories - now including
// room-guard, which graduated CONVICTING under RECOMB-06.
const roles = require('../dist/tier2-active/evidentiary-roles.js');
const lib = require('../dist/index.js');

test('every shipped signal kind is CONVICTING on its own passed gates', () => {
  for (const kind of [
    'herd-phase', 'activity-phase', 'seat-occupancy', 'vote-brigading',
    'room-hop', 'reconnect-storm', 'herd-tightness', 'room-guard',
  ]) {
    assert.equal(roles.EVIDENTIARY_ROLE_TABLE[kind], 'CONVICTING', kind);
  }
});

test('the BS-01 row is conditional: spoofed convicts, everything else only corroborates', () => {
  assert.equal(roles.evidentiaryRoleOf({ channel: 'bs01-verification-fact', state: 'spoofed' }), 'CONVICTING');
  assert.equal(roles.evidentiaryRoleOf({ channel: 'bs01-verification-fact', state: 'verified' }), 'CORROBORATING');
  assert.equal(roles.evidentiaryRoleOf({ channel: 'bs01-verification-fact', state: 'unverified' }), 'CORROBORATING');
  assert.equal(roles.evidentiaryRoleOf({ channel: 'no-such-channel' }), undefined);
});

test('audit invariant: the frozen packs decide exactly as the lab pinned', () => {
  const packs = [
    { items: [{ channel: 'pin-other-signal', fired: true }, { channel: 'pin-cohort-union', fired: true }], expected: { valid: true, eligible: false } },
    { items: [{ channel: 'c35-decoy-touch', fired: true }], expected: { valid: true, eligible: true } },
    { items: [{ channel: 'c27-budget-flag', fired: true }, { channel: 'pin-other-signal', fired: true }], expected: { valid: true, eligible: true } },
    { items: [{ channel: 'herd-phase', fired: false }, { channel: 'pin-other-signal', fired: true }], expected: { valid: true, eligible: false } },
    { items: [], expected: { valid: true, eligible: false } },
    { items: [{ channel: 'pin-other-signal', fired: true, claimedRole: 'CONVICTING' }], expected: { valid: false, eligible: false } },
    { items: [{ channel: 'bs01-verification-fact', state: 'spoofed', fired: true }], expected: { valid: true, eligible: true } },
    { items: [{ channel: 'bs01-verification-fact', state: 'verified', fired: true }], expected: { valid: true, eligible: false } },
    { items: [{ channel: 'cs01-fleet-coherence', fired: true }], expected: { valid: true, eligible: false } },
    { items: [{ channel: 'no-such-channel', fired: true }], expected: { valid: false, eligible: false } },
    // This release's addition: a fired room-guard grounds a pack.
    { items: [{ channel: 'room-guard', fired: true }], expected: { valid: true, eligible: true } },
    { items: [{ channel: 'room-guard', fired: false }, { channel: 'pin-repeat', fired: true }], expected: { valid: true, eligible: false } },
  ];
  for (const [i, pack] of packs.entries()) {
    assert.deepEqual(roles.auditEvidencePack(pack.items), pack.expected, `pack ${i + 1}`);
  }
});

test('decoration over real evaluate() outputs, including room-guard', () => {
  const factories = {
    'seat-occupancy': () => lib.createSeatOccupancySignal({ capacity: 100 }),
    'herd-tightness': () => lib.createHerdTightnessSignal(),
    'room-guard': () => lib.createRoomGuard({ capacity: 100 }),
  };
  for (const [kind, make] of Object.entries(factories)) {
    const result = make().evaluate();
    const decorated = roles.decorateSignalResult(result, { configHash: 'd'.repeat(64) });
    assert.equal(result.kind, kind);
    assert.equal(decorated.role, 'CONVICTING', kind);
    assert.equal(decorated.configHash, 'd'.repeat(64));
    assert.equal(decorated.fired, false, kind); // empty instances never fire
  }
});

test('tier restatement covers 0-3 with tier 3 forbidden for inferred evidence', () => {
  assert.deepEqual(roles.ENFORCEMENT_TIER_EVIDENCE_RULES.map((r) => r.tier), [0, 1, 2, 3]);
  assert.equal(roles.ENFORCEMENT_TIER_EVIDENCE_RULES[3].forbidden, true);
});
