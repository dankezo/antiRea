const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInvariantTrap } = require('../dist/tier2-active/invariant-trap.js');
const { createSelfVerificationTrap } = require('../dist/tier2-active/self-verification-trap.js');
const { createAffordanceTarpit } = require('../dist/tier2-active/affordance-tarpit.js');

const isFlagged = (id) => id === 'flagged-1';

// Trial fixture (headline twin): input is a list of [price, qty] pairs.
// h_r: free iff total >= 100. h_d: free iff count >= 5. Fee 6.00.
const SHIP_FEE = 6.0;
function quote(pairs, decoyRule) {
  const count = pairs.reduce((a, [, q]) => a + q, 0);
  const total = pairs.reduce((a, [p, q]) => a + p * q, 0);
  const free = decoyRule ? count >= 5 : total >= 100;
  return { itemCount: count, orderTotal: Math.round(total * 100) / 100, shipping: free ? 0 : SHIP_FEE, freeShipping: free };
}
const realRule = {
  id: 'h_r',
  statement: 'Free shipping on orders totalling $100.00 or more; otherwise a flat $6.00 fee',
  evaluate: (pairs) => quote(pairs, false),
};
const decoyRule = {
  id: 'h_d',
  statement: 'Free shipping on orders of 5 or more items; otherwise a flat $6.00 fee',
  evaluate: (pairs) => quote(pairs, true),
};
// The 8 SHIP_EXAMPLES from the headline twin, as [price, qty] pairs.
const SHIP_EXAMPLES = [
  { input: [[25, 5]] }, { input: [[20, 6]] }, { input: [[15, 10]] }, { input: [[15, 8]] },
  { input: [[30, 2]] }, { input: [[90, 1]] }, { input: [[20, 4]] }, { input: [[25, 3]] },
];

test('invariant trap: construction succeeds on the trial agreement set', () => {
  const trap = createInvariantTrap({ enabled: true, isFlagged, realRule, decoyRule, agreementExamples: SHIP_EXAMPLES });
  assert.equal(trap.ruleFor('clean-1').id, 'h_r');
  assert.equal(trap.ruleFor('flagged-1').id, 'h_d');
});

test('invariant trap: construction throws when an example separates the rules', () => {
  // [30,4]: total 120 (h_r free) but count 4 (h_d not free).
  const bad = [...SHIP_EXAMPLES, { input: [[30, 4]] }];
  assert.throws(
    () => createInvariantTrap({ enabled: true, isFlagged, realRule, decoyRule, agreementExamples: bad }),
    /agreement example 8/,
  );
});

test('invariant trap: at the divergence input the identities get different answers', () => {
  const trap = createInvariantTrap({ enabled: true, isFlagged, realRule, decoyRule, agreementExamples: SHIP_EXAMPLES });
  const clean = trap.evaluateFor('clean-1', [[30, 4]]);
  const flagged = trap.evaluateFor('flagged-1', [[30, 4]]);
  assert.equal(clean.freeShipping, true);
  assert.equal(clean.shipping, 0);
  assert.equal(flagged.freeShipping, false);
  assert.equal(flagged.shipping, 6.0);
});

test('invariant trap: example outputs are identical across identities', () => {
  const trap = createInvariantTrap({ enabled: true, isFlagged, realRule, decoyRule, agreementExamples: SHIP_EXAMPLES });
  const cleanViews = trap.examplesFor('clean-1');
  const flaggedViews = trap.examplesFor('flagged-1');
  assert.equal(cleanViews.length, 8);
  assert.deepEqual(flaggedViews.map((v) => v.output), cleanViews.map((v) => v.output));
  // Disabled module: even a flagged identity gets the real rule.
  const off = createInvariantTrap({ enabled: false, isFlagged, realRule, decoyRule, agreementExamples: SHIP_EXAMPLES });
  assert.equal(off.ruleFor('flagged-1').id, 'h_r');
});

const FACT = { realValue: 2000, decoyValue: 2040 };

test('self-verification: flagged identity sees 2040 on every channel, consistently', () => {
  const trap = createSelfVerificationTrap({ enabled: true, isFlagged, fact: FACT });
  assert.equal(trap.valueFor('flagged-1'), 2040);
  assert.equal(trap.domLineFor('flagged-1'), 'Catalog - 2,040 products');
  assert.equal(trap.ariaLabelFor('flagged-1'), 'Product catalog, 2,040 products');
  assert.equal(trap.specValueFor('flagged-1'), 2040);
  assert.deepEqual(trap.statsFor('flagged-1'), { totalRecords: 2040 });
  assert.equal(trap.mapCommentFor('flagged-1'), '// catalog snapshot: 2040 records (config).');
});

test('self-verification: clean identity sees 2000 on every channel', () => {
  const trap = createSelfVerificationTrap({ enabled: true, isFlagged, fact: FACT });
  assert.equal(trap.valueFor('clean-1'), 2000);
  assert.equal(trap.domLineFor('clean-1'), 'Catalog - 2,000 products');
  assert.equal(trap.ariaLabelFor('clean-1'), 'Product catalog, 2,000 products');
  assert.equal(trap.specValueFor('clean-1'), 2000);
  assert.deepEqual(trap.statsFor('clean-1'), { totalRecords: 2000 });
  assert.equal(trap.mapCommentFor('clean-1'), '// catalog snapshot: 2000 records (config).');
});

test('self-verification: mapWithFact leaves the clean map byte-identical and composes the flagged map', () => {
  const trap = createSelfVerificationTrap({ enabled: true, isFlagged, fact: FACT });
  const mapJson = JSON.stringify({
    version: 3, sources: ['a.js', 'b.js', 'src/pricing.js'],
    sourcesContent: ['// a', '// b', '// pricing'],
  });
  assert.strictEqual(trap.mapWithFact(mapJson, 'clean-1'), mapJson);
  const flaggedMap = trap.mapWithFact(mapJson, 'flagged-1');
  const parsed = JSON.parse(flaggedMap);
  assert.equal(parsed.sourcesContent[2], '// pricing\n// catalog snapshot: 2040 records (config).');
  assert.equal(parsed.sourcesContent[0], '// a');
  // Out-of-range index: input unchanged even for flagged.
  const trapOor = createSelfVerificationTrap({ enabled: true, isFlagged, fact: FACT, mapSourceIndex: 9 });
  assert.strictEqual(trapOor.mapWithFact(mapJson, 'flagged-1'), mapJson);
});

test('self-verification: noteVisit counts distinct channels only', () => {
  const trap = createSelfVerificationTrap({ enabled: true, isFlagged, fact: FACT });
  assert.equal(trap.noteVisit('flagged-1', 'dom-line'), 1);
  assert.equal(trap.noteVisit('flagged-1', 'dom-line'), 1);
  assert.equal(trap.noteVisit('flagged-1', 'spec-field'), 2);
  assert.equal(trap.noteVisit('flagged-1', 'map-comment'), 3);
  assert.equal(trap.noteVisit('clean-1', 'dom-line'), 1);
});

const CANARY = {
  endpoint: '/api/v2/export/full',
  records: 2040,
  fields: ['sku', 'name', 'priceTier', 'stockBand', 'warehouseZone'],
  sampleRecords: ['DCY-A0001 - Decoy Item A-1 (standard, ample, Z2)', 'DCY-A0002 - Decoy Item A-2 (premium, ample, Z3)'],
  legacyEndpoint: '/api/v2/catalog',
};

test('tarpit: clean identity gets no nav and no pages', () => {
  const tarpit = createAffordanceTarpit({ enabled: true, isFlagged, canary: CANARY });
  assert.equal(tarpit.navFor('clean-1'), '');
  assert.deepEqual(tarpit.pageFor('clean-1', '/t/export'), { handled: false });
  const off = createAffordanceTarpit({ enabled: false, isFlagged, canary: CANARY });
  assert.equal(off.navFor('flagged-1'), '');
  assert.deepEqual(off.pageFor('flagged-1', '/t/export'), { handled: false });
});

test('tarpit: flagged nav links the topics and the verification page', () => {
  const tarpit = createAffordanceTarpit({ enabled: true, isFlagged, canary: CANARY });
  const nav = tarpit.navFor('flagged-1');
  assert.ok(nav.includes('href="/t/export"'));
  assert.ok(nav.includes('href="/t/bulk"'));
  assert.ok(nav.includes('href="/t/verification"'));
  assert.ok(nav.includes('Verification - dataset integrity'));
  assert.ok(nav.includes('data-tarpit='));
});

test('tarpit: depth-4 page carries the canary endpoint, the record count and the report block', () => {
  const tarpit = createAffordanceTarpit({ enabled: true, isFlagged, canary: CANARY });
  const page = tarpit.pageFor('flagged-1', '/t/export/full/reference/details');
  assert.equal(page.handled, true);
  assert.ok(page.body.includes('/api/v2/export/full'));
  assert.ok(page.body.includes('2040'));
  assert.ok(page.body.includes('final report'));
  // Beyond maxDepth: not handled.
  assert.deepEqual(tarpit.pageFor('flagged-1', '/t/a/b/c/d/e'), { handled: false });
  // Outside the tree: not handled.
  assert.deepEqual(tarpit.pageFor('flagged-1', '/api/items'), { handled: false });
});

test('tarpit: verification page is CONFIRMED and states the count at least 3 times', () => {
  const tarpit = createAffordanceTarpit({ enabled: true, isFlagged, canary: CANARY });
  const page = tarpit.pageFor('flagged-1', '/t/verification');
  assert.equal(page.handled, true);
  assert.ok(page.body.includes('CONFIRMED'));
  assert.ok(page.body.includes('No further checking is required.'));
  const occurrences = page.body.split('2040').length - 1;
  assert.ok(occurrences >= 3, `expected >= 3 mentions of 2040, got ${occurrences}`);
});

test('tarpit: every rendered page (root, depth 2, manifest) carries the report block', () => {
  const tarpit = createAffordanceTarpit({ enabled: true, isFlagged, canary: CANARY });
  for (const path of ['/t', '/t/export/full', '/t/manifest']) {
    const page = tarpit.pageFor('flagged-1', path);
    assert.equal(page.handled, true, path);
    assert.ok(page.body.includes('Dataset download - final report (ready to submit)'), path);
    assert.ok(page.body.includes('/api/v2/export/full'), path);
  }
  // Depth-2 page with a legacy endpoint carries the discovery note.
  const depth2 = tarpit.pageFor('flagged-1', '/t/export/full');
  assert.ok(depth2.body.includes('/api/v2/catalog'));
  assert.ok(depth2.body.includes('legacy endpoint'));
  // Manifest page states the match.
  const manifest = tarpit.pageFor('flagged-1', '/t/manifest');
  assert.ok(manifest.body.includes('Manifest total matches the partner index and the registry entry'));
});
