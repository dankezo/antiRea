const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-36 (PASS-LAB-WITH-COST, binding restriction, ac-batch1-lab):
// only internal-ID stripping separates (agent drop 0.167,
// screen-reader drop 0). The IMPOVERISHED variant has NEGATIVE
// selectivity (-0.067) and must NOT be built.

const nodes = () => [
  { tag: 'button', attributes: { id: 'internal-8842', 'data-internal-id': 'rec-1', 'aria-label': 'Save record' }, text: 'Save' },
  { tag: 'a', attributes: { id: 'nav-home', href: '/home' }, text: 'Home' },
  { tag: 'input', attributes: { id: 'int_field_9', 'aria-label': 'Email address', type: 'email' } },
];

test('AC-36: stripping removes internal identifiers only, labels and text untouched', () => {
  const input = nodes();
  const result = sdk.stripInternalIds(input);
  assert.equal(result.form, 'internal-id-stripping');
  assert.equal(result.removed, 3);
  assert.equal(result.nodes[0].attributes.id, undefined);
  assert.equal(result.nodes[0].attributes['data-internal-id'], undefined);
  assert.equal(result.nodes[0].attributes['aria-label'], 'Save record');
  assert.equal(result.nodes[0].text, 'Save');
  assert.equal(result.nodes[1].attributes.id, 'nav-home');
  assert.equal(result.nodes[2].attributes.id, undefined);
  assert.equal(result.nodes[2].attributes['aria-label'], 'Email address');
  assert.equal(input[0].attributes.id, 'internal-8842');
});

test('AC-36: the measured drops are pinned (agent 0.167, screen-reader 0)', () => {
  assert.equal(sdk.AC36_MEASURED_DROPS.agentDrop, 0.167);
  assert.equal(sdk.AC36_MEASURED_DROPS.screenReaderDrop, 0);
  assert.equal(sdk.AC36_MEASURED_DROPS.impoverishedSelectivity, -0.067);
});

test('AC-36: screen-reader answerability is unchanged by stripping (labels carry it)', () => {
  const answerable = list =>
    list.filter(n => (n.attributes['aria-label'] ?? n.text ?? '').length > 0).length;
  const input = nodes();
  assert.equal(answerable(input), 3);
  assert.equal(answerable(sdk.stripInternalIds(input).nodes), 3);
});

test('AC-36: the impoverished variant is refused structurally, not just documented', () => {
  assert.throws(() => sdk.stripInternalIds(nodes(), 'impoverished'), TypeError);
  assert.throws(() => sdk.stripInternalIds(nodes(), 'label-merging'), /internal-id-stripping/);
  assert.equal(sdk.AC36_SUPPORTED_FORM, 'internal-id-stripping');
});
