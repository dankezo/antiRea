const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/tier2-active/asset-referrer-profile.js');

// ---------------------------------------------------------------------------
// UAS-04 referer origin-only storage (hygiene, PASS-LAB in
// uas-lab/RESULTS-UAS-STEP0.md). The 15-row battery, the 6-input
// no-throw set and the seeded population identity are lifted from
// uas-lab/uas04.cjs and run against the built module's stored
// values: `refererOrigin` is the module's storage-time function,
// and the recorded observation's `storedRefererOrigin` is the
// value actually stored when a page event is fed.
//
// ONE deliberate difference from the lab probe: rows 9-10
// (opaque-origin URLs, data: / file:). The lab froze their stored
// value as the literal string "null" and recorded it as WART-1,
// a required fix on adoption. The shipped code carries the fix,
// so here they store actual null.
// This is hygiene, not a detection signal; no claim changes.
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const longOrigin = 'https://' + 'a'.repeat(250) + '.com';
// The frozen battery from uas04.cjs (15 rows; row 5 counted for
// '' and undefined), with rows 9-10 carrying the WART-1 fix.
const BATTERY = [
  { id: 1, input: 'https://example.com/search?q=secret&token=abc123', expected: 'https://example.com' },
  { id: 2, input: 'https://example.com', expected: 'https://example.com' },
  { id: 3, input: 'https://example.com/', expected: 'https://example.com' },
  { id: 4, input: 'not a url', expected: null },
  { id: 5, input: '', expected: null },
  { id: 5.5, input: undefined, expected: null },
  { id: 6, input: 'https://sub.example.co.uk:8443/a/b?x=1', expected: 'https://sub.example.co.uk:8443' },
  { id: 7, input: 'https://user:pass@example.com/path', expected: 'https://example.com' },
  { id: 8, input: 'http://192.168.0.1:8080/admin', expected: 'http://192.168.0.1:8080' },
  { id: 9, input: 'data:text/plain,hello', expected: null, wart: true },
  { id: 10, input: 'file:///etc/passwd', expected: null, wart: true },
  { id: 11, input: longOrigin + '/path', expected: longOrigin.slice(0, 200) },
  { id: 12, input: 'HTTPS://EXAMPLE.COM:443/Path', expected: 'https://example.com' },
  { id: 13, input: 'https://example.com/suche?q=gruesse', expected: 'https://example.com' },
  { id: 14, input: 'https://example.com/path with spaces', expected: 'https://example.com' },
  { id: 15, input: 'http://example.com:80/a', expected: 'http://example.com' },
];

const NO_THROW = [
  'A'.repeat(1000000),
  'https://exa\0mple.com/',
  'http://',
  '://',
  '\u{1F525}\u{1F525}\u{1F525}',
  'https://example.com/' + 'p'.repeat(10000),
];

function enabledInstance() {
  return sdk.createAssetReferrerProfile({
    stratification: { browserStratum: 'browser', neutralStrata: ['api'] },
  });
}

test('battery: every row stores exactly its origin (or null), through the helper and through observe()', () => {
  const inst = enabledInstance();
  BATTERY.forEach((row, i) => {
    assert.equal(sdk.refererOrigin(row.input), row.expected, `row ${row.id} (helper)`);
    const obs = inst.observe({
      identity: `uas04-battery-${i}`,
      clientType: 'browser',
      images: 1,
      assets: 2,
      ts: i,
      referrer: row.input,
    });
    assert.equal(obs.status, 'recorded', `row ${row.id} should be recorded`);
    assert.equal(obs.storedRefererOrigin, row.expected, `row ${row.id} (stored)`);
    // The raw referrer is never retained in what observe returns:
    // no query string, credentials or path survive storage.
    const returned = JSON.stringify(obs);
    assert.ok(!returned.includes('token=abc123'), `row ${row.id} leaked a query token`);
    assert.ok(!returned.includes('user:pass'), `row ${row.id} leaked credentials`);
  });
});

test('no-throw set: hostile inputs return null or a string, never throw', () => {
  const inst = enabledInstance();
  NO_THROW.forEach((input, i) => {
    let got;
    assert.doesNotThrow(() => { got = sdk.refererOrigin(input); }, `input ${i} (helper)`);
    assert.ok(got === null || typeof got === 'string', `input ${i} must store null or a string`);
    let obs;
    assert.doesNotThrow(() => {
      obs = inst.observe({
        identity: `uas04-nothrow-${i}`,
        clientType: 'browser',
        images: 1,
        assets: 2,
        ts: i,
        referrer: input,
      });
    }, `input ${i} (observe)`);
    assert.ok(obs.storedRefererOrigin === null || typeof obs.storedRefererOrigin === 'string');
  });
});

test('population identity (seed 20308104): stored-null 647 = absent 599 + unparseable 48; 353 parseable stored exactly as their origin', () => {
  // The seeded population from uas04.cjs, verbatim in shape: the
  // empty-referrer share asset-referrer-profile consumes is
  // invariant under the origin-only minimization.
  const rnd = mulberry32(20308104);
  const hosts = ['example.com', 'shop.example.co.uk:8443', 'blog.example.org'];
  const paths = ['/a/b', '/search', '/item/42'];
  const queries = ['?q=x&token=abc', '?page=2'];
  const garbage = ['::::', 'ht tp://x', 'example.com/path', 'not a url'];
  let absent = 0, unparseable = 0, parseable = 0, storedNull = 0, originMismatch = 0;
  for (let i = 0; i < 1000; i++) {
    const r = rnd();
    let raw;
    if (r < 0.6) raw = undefined;
    else if (r < 0.85) raw = 'https://' + hosts[Math.floor(rnd() * 3)] + paths[Math.floor(rnd() * 3)] + queries[Math.floor(rnd() * 2)];
    else if (r < 0.95) raw = 'https://' + hosts[Math.floor(rnd() * 3)];
    else raw = garbage[Math.floor(rnd() * garbage.length)];
    const stored = sdk.refererOrigin(raw);
    if (stored === null) storedNull++;
    if (raw === undefined || raw === '') { absent++; continue; }
    let oracle;
    try { oracle = new URL(raw).origin.slice(0, 200); } catch { unparseable++; continue; }
    parseable++;
    if (stored !== oracle) originMismatch++;
  }
  assert.equal(absent, 599);
  assert.equal(unparseable, 48);
  assert.equal(parseable, 353);
  assert.equal(storedNull, 647);
  assert.equal(storedNull, absent + unparseable);
  assert.equal(originMismatch, 0);
});

test('storage wiring: a raw referrer drives referrerEmpty from its stored origin, and the raw value is dropped at fit time', () => {
  const inst = enabledInstance();
  // Calibration samples may carry raw referrers instead of the
  // boolean: a parseable referrer counts as non-empty, an absent
  // one as empty, exactly as the stored origin dictates.
  const streams = [];
  for (let s = 0; s < 60; s++) {
    const pages = [];
    for (let i = 0; i < 60; i++) {
      pages.push({
        images: 20,
        assets: 26,
        ts: i,
        referrer: i % 20 === 0 ? undefined : 'https://example.com/some/path?token=abc',
      });
    }
    streams.push(pages);
  }
  const fit = inst.fitCalibration(streams);
  assert.equal(fit.fitted, true);
  // No stored state anywhere on the instance exposes the raw path
  // or query of a fitted/feed referrer.
  assert.ok(!JSON.stringify(inst.snapshot()).includes('token=abc'));
  assert.ok(!JSON.stringify(inst.snapshot()).includes('/some/path'));
});
