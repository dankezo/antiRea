'use strict';
// NHS-07 CrowdSec feed importer - suite version of nhs-lab/nhs07.cjs.
// The feed is host-supplied DATA (no network): frozen expectations
// are exact tier contributions (ban 100 / captcha 40 / throttle 65),
// sweep on replace, corrupt or over-25%-malformed rejected with
// last-good intact, same-mtime skipped, expiry per entry. The
// contributions are advisory in antiRea form.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cf = require('../dist/tier2-active/crowdsec-feed.js');

const NOW = 1000000;
const LINES_A = [
  '66.249.66.10 ban 1003600',
  '66.249.66.11 ban 1003600',
  '66.249.66.12 captcha 1003600',
  '66.249.66.13 throttle 1003600',
  '66.249.66.14 ban 999000',
  'this is not a decision',
];
const LINES_B = [
  '66.249.66.10 ban 1003600',
  '66.249.66.12 captcha 1003600',
  '66.249.66.13 throttle 1003600',
  '10.0.0.0/8 ban 1003600',
];
const LINES_D = [
  '66.249.66.20 ban 1003600',
  '66.249.66.21 captcha 1003600',
  'garbage line here',
  'also not a decision',
];

test('feed A accepted (5 valid, 1 malformed) with exact tier contributions', () => {
  const feed = cf.createCrowdsecFeedImporter();
  const loadA = feed.load(cf.buildCrowdsecFeed(LINES_A), 'A1');
  assert.equal(loadA.result, 'accepted');
  assert.equal(loadA.valid, 5);
  assert.equal(loadA.malformed, 1);
  assert.equal(feed.contributionFor('66.249.66.10', NOW), 100);
  assert.equal(feed.contributionFor('66.249.66.12', NOW), 40);
  assert.equal(feed.contributionFor('66.249.66.13', NOW), 65);
  assert.deepEqual(cf.CROWDSEC_TIER_CONTRIBUTIONS, { ban: 100, captcha: 40, throttle: 65 });
});

test('expired line never hits; absent IP misses', () => {
  const feed = cf.createCrowdsecFeedImporter();
  feed.load(cf.buildCrowdsecFeed(LINES_A), 'A1');
  assert.equal(feed.contributionFor('66.249.66.14', NOW), null);
  assert.equal(feed.contributionFor('66.249.66.15', NOW), null);
});

test('feed B sweeps the removed IP; its CIDR line is malformed and never matches', () => {
  const feed = cf.createCrowdsecFeedImporter();
  feed.load(cf.buildCrowdsecFeed(LINES_A), 'A1');
  const loadB = feed.load(cf.buildCrowdsecFeed(LINES_B), 'B1');
  assert.equal(loadB.result, 'accepted');
  assert.equal(feed.contributionFor('66.249.66.11', NOW), null, 'swept by replacement');
  assert.equal(feed.contributionFor('66.249.66.10', NOW), 100, 'kept');
  assert.equal(feed.contributionFor('10.1.2.3', NOW), null, 'CIDR line never matches');
});

test('corrupt-CRC feed rejected with last-good table intact', () => {
  const feed = cf.createCrowdsecFeedImporter();
  feed.load(cf.buildCrowdsecFeed(LINES_B), 'B1');
  const snap = feed.snapshot();
  const loadC = feed.load(cf.buildCrowdsecFeed(LINES_A, true), 'C1');
  assert.equal(loadC.result, 'rejected');
  assert.equal(feed.snapshot(), snap);
});

test('over-25%-malformed feed rejected with last-good table intact', () => {
  const feed = cf.createCrowdsecFeedImporter();
  feed.load(cf.buildCrowdsecFeed(LINES_B), 'B1');
  const snap = feed.snapshot();
  const loadD = feed.load(cf.buildCrowdsecFeed(LINES_D), 'D1');
  assert.equal(loadD.result, 'rejected');
  assert.equal(loadD.reason, 'malformed-fraction');
  assert.equal(feed.snapshot(), snap);
});

test('same-mtime re-presentation skipped, generation constant', () => {
  const feed = cf.createCrowdsecFeedImporter();
  feed.load(cf.buildCrowdsecFeed(LINES_B), 'B1');
  const gen = feed.generation;
  const again = feed.load(cf.buildCrowdsecFeed(LINES_B), 'B1');
  assert.equal(again.result, 'skipped');
  assert.equal(feed.generation, gen);
});

test('stale entries age out only at their own expiry: hit at expiry-1, miss at expiry+1', () => {
  const feed = cf.createCrowdsecFeedImporter();
  feed.load(cf.buildCrowdsecFeed(LINES_B), 'B1');
  assert.equal(feed.contributionFor('66.249.66.10', 1003599), 100);
  assert.equal(feed.contributionFor('66.249.66.10', 1003601), null);
});

test('bad header and missing trailer reject without touching the table', () => {
  const feed = cf.createCrowdsecFeedImporter();
  assert.equal(feed.load('nonsense\n', 'X1').result, 'rejected');
  assert.equal(feed.load(cf.CROWDSEC_FEED_HEADER + '\n66.249.66.10 ban 1003600\n', 'X2').result, 'rejected');
  assert.equal(feed.snapshot(), '');
});
