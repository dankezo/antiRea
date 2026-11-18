'use strict';
// ABG-02 canary preload miss - suite version of abg-lab/abg02.cjs.
// Frozen gates (seed 20321202): browser client never misses; the
// never-fetching client misses exactly at the page-5 check on the
// 15 s schedule and does not re-fire; the preload-blocked client is
// a distinct miss class. Descriptive pacing arm: 20 replicas split
// 3/10/7 over fire pages 5/6/7.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const m = require('../dist/tier2-active/canary-preload-probe.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PAGE_TIMES_S = [0, 15, 30, 45, 60, 75];
function runClient(kind) {
  const probe = m.createCanaryPreloadProbe();
  const id = 'client-' + kind;
  const log = [];
  for (const tS of PAGE_TIMES_S) {
    const t = tS * 1000;
    probe.noteHtml(id, t, kind === 'C' ? { preloadBlocked: true } : {});
    if (kind === 'A') probe.noteProbeFetch(id, t);
    log.push(probe.check(id, t));
  }
  return log;
}

test('ABG-02 gate A: a browser that fetches the probe never misses over 6 pages', () => {
  const log = runClient('A');
  assert.equal(log.filter((r) => r.fired).length, 0);
  assert.equal(log[5].confirmed, true);
});

test('ABG-02 gate B: a non-executing client misses exactly at page 5, weight 35 not 20, no re-fire', () => {
  const log = runClient('B');
  assert.equal(log[4].fired, true);
  assert.equal(log[4].weight, 35);
  assert.equal(log[4].triggerValue, 20);
  assert.equal(log[4].missClass, 'no_execution');
  assert.equal(log[4].enforcement, 'none');
  assert.equal(log.filter((r) => r.fired).length, 1);
  assert.equal(log[5].fired, false, 'counter reset after fire: no re-fire on the next check');
});

test('ABG-02 control: no miss before 5 pages or before 60 s', () => {
  const log = runClient('B');
  for (let i = 0; i < 4; i++) assert.equal(log[i].fired, false, `page ${i + 1}`);
});

test('ABG-02 gate C: preload-blocked client fires but is recorded as the distinct FP class', () => {
  const log = runClient('C');
  assert.equal(log[4].fired, true);
  assert.equal(log[4].missClass, 'preload_blocked');
});

test('ABG-02: the probe tag is a preload link to the given path', () => {
  assert.equal(m.canaryPreloadProbeTag('/canary-probe'), '<link rel="preload" as="fetch" href="/canary-probe">');
});

test('ABG-02 descriptive: 20 seeded pacing replicas split 3/10/7 over fire pages 5/6/7 (seed 20321202)', () => {
  const rand = mulberry32(20321202);
  const counts = { 5: 0, 6: 0, 7: 0 };
  for (let i = 0; i < 20; i++) {
    const intervalS = 10 + rand() * 8;
    const probe = m.createCanaryPreloadProbe();
    let firePage = null;
    for (let p = 0; p < 10; p++) {
      const t = Math.round(p * intervalS * 1000);
      probe.noteHtml('rep', t);
      if (probe.check('rep', t).fired) { firePage = p + 1; break; }
    }
    assert.ok(firePage === 5 || firePage === 6 || firePage === 7, `replica ${i} fire page ${firePage}`);
    counts[firePage]++;
  }
  assert.deepEqual(counts, { 5: 3, 6: 10, 7: 7 });
});
