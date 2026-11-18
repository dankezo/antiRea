const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
// ABP-03 THE-CURRENT-REQUEST-SCORE-MUST-NOT-BE-DILUTED-BY-A-HISTORY-
// AVERAGE. Neighbour measurement: the operative score was a
// 20-sample average - 19 banked 95s plus 1 current 5 gave exactly
// 90.5 and a consequence delta of +0 - and the current-score branch
// was unreachable because recordRequest always pushed into the
// average first.
//
// AUDIT RESULT for antiRea (this file is the deliverable): the
// pattern is NOT present in the shipped scoring core.
// - createFlowScorer (the per-session score) is ADDITIVE: each
//   event adds its own weight to the session score at observe time
//   (state.score += add); no division by a sample count exists
//   anywhere in the module.
// - createCusumTripwire accumulates per-event log-likelihood
//   increments into a one-sided sum with a zero floor; the current
//   event's increment enters at full weight.
// - The one average-shaped statistic in the core, the CUSUM
//   velocity stream's dwell EWMA (0.7 old + 0.3 current), is a
//   dwell ESTIMATOR feeding a stream input, not the operative
//   score: it cannot dilute a score toward a banked history, and
//   its input is validated (implausible dwell is treated as no
//   cursor) before it can touch the estimator.
// These tests pin the additive property behaviourally: a single
// current high-weight event must move a session's score by its
// full weight, and a long calm history must not dilute the next
// event's contribution.
const sdk = require('../dist/index.js');

test('flow scorer: a single current canary event contributes its full weight to a fresh session', () => {
  const scorer = sdk.createFlowScorer({});
  assert.equal(scorer.score('s1'), 0);
  const result = scorer.observe('s1', { routeClass: 'canary', status: 404 });
  // Canary contact weight is 50 (DEFAULT_FLOW_WEIGHTS): the current
  // event's contribution is the full 50, undiluted.
  assert.equal(result.score, sdk.DEFAULT_FLOW_WEIGHTS.canaryContact);
  assert.equal(scorer.score('s1'), sdk.DEFAULT_FLOW_WEIGHTS.canaryContact);
});

test('flow scorer: a calm history does not dilute the next event contribution', () => {
  const scorer = sdk.createFlowScorer({});
  // 19 calm events (the neighbour fixture's banked-history shape):
  // polite detail views score 0 and, critically, form no average.
  for (let i = 0; i < 19; i++) {
    scorer.observe('s2', { routeClass: 'detail', status: 200 });
  }
  assert.equal(scorer.score('s2'), 0);
  const hit = scorer.observe('s2', { routeClass: 'canary', status: 404 });
  // The contribution is IDENTICAL to the fresh-session contribution
  // above: 50, not an average over 20 samples (the neighbour's
  // 90.5-with-delta-+0 shape cannot occur).
  assert.equal(hit.score, sdk.DEFAULT_FLOW_WEIGHTS.canaryContact);
});

test('flow scorer: contributions stack additively, each at full weight, in order', () => {
  const scorer = sdk.createFlowScorer({});
  scorer.observe('s3', { routeClass: 'list', status: 429, pageSizeRequested: 500 }); // boundary probe +10
  assert.equal(scorer.score('s3'), 10);
  scorer.observe('s3', { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 4 }); // persistence +25
  assert.equal(scorer.score('s3'), 35);
  scorer.observe('s3', { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 4 }); // persistence +25
  assert.equal(scorer.score('s3'), 60);
});

test('flow scorer source carries no averaging of the operative score', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'tier2-active', 'flow-scorer.ts'), 'utf8');
  assert.ok(!/score\s*\/=/.test(src), 'operative score must never be divided');
  assert.ok(!/averageScore|scoreAverage|meanScore/.test(src), 'no averaged score symbol may appear');
  assert.match(src, /state\.score \+=/);
});

test('cusum source: no sample-count division of the operative accumulator', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'tier2-active', 'cusum-tripwire.ts'), 'utf8');
  assert.ok(!/accumulator\s*\/=/.test(src));
  assert.ok(!/score\s*\/=\s*\w*[Cc]ount/.test(src));
});
