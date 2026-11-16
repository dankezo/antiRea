'use strict';
// UAS-01 header-coherence (V1 form) - suite version of uas-lab/uas01.cjs.
// The truth-table generator, strata generators and attack shapes are
// lifted from the frozen Step-0 probe (REGISTRATION-UAS-STEP0.md);
// expectations are the frozen V1 codes/score/flag (from_header excluded
// from the sum, reported as the separate hasFromHeader boolean).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const hc = require('../dist/tier2-active/header-coherence.js');

const UA = {
  chrome120: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  edge120: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  firefox121: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  safari17: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  chrome70: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36',
  firefox60: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:60.0) Gecko/20100101 Firefox/60.0',
  safari12: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_14) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Safari/605.1.15',
  gptbot: 'GPTBot/1.0',
  curl: 'curl/8.4.0',
};

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const run = (headers, httpVersion, uaStr) =>
  hc.analyzeHeaderCoherence({ headers, httpVersion, userAgent: uaStr });
const sorted = (arr) => [...arr].sort();

// ---------- truth table (Chrome 120 claim, 576 rows), lifted from uas01.cjs ----------
function buildRow(sw) {
  const h = {};
  if (sw.accept === 'ok') h['accept'] = 'text/html,application/xhtml+xml,*/*;q=0.8';
  else if (sw.accept === 'star') h['accept'] = '*/*';
  if (sw.enc === 'ok') h['accept-encoding'] = 'gzip, deflate, br';
  else if (sw.enc === 'weak') h['accept-encoding'] = 'identity';
  if (!sw.alMissing) h['accept-language'] = 'en-US,en;q=0.9';
  if (!sw.sfMissing) { h['sec-fetch-mode'] = 'navigate'; h['sec-fetch-dest'] = 'document'; h['sec-fetch-site'] = 'none'; }
  if (!sw.chMissing) h['sec-ch-ua'] = '"Chromium";v="120"';
  h['connection'] = sw.connClose ? 'close' : 'keep-alive';
  if (sw.fromPresent) h['from'] = 'probe@example.com';
  return { h, ver: sw.http10 ? '1.0' : '1.1' };
}
function expectedCodesV0(sw) {
  const e = [];
  if (sw.accept === 'star') e.push('accept_star');
  if (sw.accept === 'missing') e.push('no_accept');
  if (sw.enc === 'weak') e.push('weak_accept_encoding');
  if (sw.enc === 'missing') e.push('no_accept_encoding');
  if (sw.alMissing) e.push('no_accept_language');
  if (sw.http10) e.push('http_1_0');
  if (sw.sfMissing) e.push('no_sec_fetch');
  if (sw.chMissing) e.push('no_client_hints');
  if (sw.connClose && !sw.http10) e.push('connection_close');
  if (sw.fromPresent) e.push('from_header');
  return e;
}

test('truth table: all 576 switch rows equal the frozen V1 codes/score/flag', () => {
  let rows = 0;
  for (const accept of ['ok', 'star', 'missing'])
    for (const enc of ['ok', 'weak', 'missing'])
      for (const alMissing of [false, true])
        for (const http10 of [false, true])
          for (const sfMissing of [false, true])
            for (const chMissing of [false, true])
              for (const connClose of [false, true])
                for (const fromPresent of [false, true]) {
                  const sw = { accept, enc, alMissing, http10, sfMissing, chMissing, connClose, fromPresent };
                  const { h, ver } = buildRow(sw);
                  const r = run(h, ver, UA.chrome120);
                  rows++;
                  const expV1 = expectedCodesV0(sw).filter((c) => c !== 'from_header');
                  const expScore = expV1.reduce((s, c) => s + hc.HEADER_COHERENCE_WEIGHTS[c], 0);
                  assert.deepEqual(sorted(r.codes), sorted(expV1), `codes row ${JSON.stringify(sw)}`);
                  assert.equal(r.score, expScore, `score row ${JSON.stringify(sw)}`);
                  assert.equal(r.flagged, expScore >= 4, `flag row ${JSON.stringify(sw)}`);
                  assert.equal(r.hasFromHeader, fromPresent, `from row ${JSON.stringify(sw)}`);
                  assert.equal(r.claimsBrowser, true);
                  assert.equal(r.enforcement, 'none');
                }
  assert.equal(rows, 576);
});

test('gating rows: Firefox/Safari never produce no_client_hints; bot and curl UAs are out of scope', () => {
  const allDefect = { accept: 'missing', enc: 'missing', alMissing: true, http10: false, sfMissing: true, chMissing: true, connClose: false, fromPresent: false };
  const { h, ver } = buildRow(allDefect);
  const expectedBrowserCodes = ['no_accept', 'no_accept_encoding', 'no_accept_language', 'no_sec_fetch'];
  const ff = run(h, ver, UA.firefox121);
  assert.deepEqual(sorted(ff.codes), sorted(expectedBrowserCodes), 'firefox gating row');
  assert.equal(ff.score, 9);
  const sf = run(h, ver, UA.safari17);
  assert.deepEqual(sorted(sf.codes), sorted(expectedBrowserCodes), 'safari gating row');
  assert.equal(sf.score, 9);

  const botRow = buildRow({ ...allDefect, fromPresent: true });
  const bot = run(botRow.h, botRow.ver, UA.gptbot);
  assert.deepEqual(bot.codes, [], 'bot UA: V1 codes empty (V0 would be [from_header] only)');
  assert.equal(bot.hasFromHeader, true);
  assert.equal(bot.score, 0);
  assert.equal(bot.flagged, false);
  assert.equal(bot.claimsBrowser, false);

  const curlRow = buildRow(allDefect);
  const c0 = run(curlRow.h, curlRow.ver, UA.curl);
  assert.deepEqual(c0.codes, [], 'curl UA without From: no codes');
  assert.equal(c0.hasFromHeader, false);

  const curlRowF = buildRow({ ...allDefect, fromPresent: true });
  const c1 = run(curlRowF.h, curlRowF.ver, UA.curl);
  assert.deepEqual(c1.codes, [], 'curl UA with From: V1 codes empty');
  assert.equal(c1.hasFromHeader, true);
});

// ---------- strata FP cells, lifted from uas01.cjs ----------
const fullSet = (kind) => {
  const h = {
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-US,en;q=0.9',
    'connection': 'keep-alive',
  };
  if (kind === 'chromium') { h['sec-fetch-mode'] = 'navigate'; h['sec-fetch-dest'] = 'document'; h['sec-fetch-site'] = 'none'; h['sec-ch-ua'] = '"Chromium";v="120"'; }
  if (kind === 'firefox') { h['sec-fetch-mode'] = 'navigate'; h['sec-fetch-dest'] = 'document'; h['sec-fetch-site'] = 'none'; }
  if (kind === 'safari') { h['sec-fetch-mode'] = 'navigate'; h['sec-fetch-dest'] = 'document'; h['sec-fetch-site'] = 'none'; }
  return h;
};

test('stratum A (direct modern, seed 20308101): flagged 0.0%', () => {
  const templatesA = [
    { uaStr: UA.chrome120, kind: 'chromium' }, { uaStr: UA.edge120, kind: 'chromium' },
    { uaStr: UA.firefox121, kind: 'firefox' }, { uaStr: UA.safari17, kind: 'safari' },
  ];
  const rnd = mulberry32(20308101);
  let flagged = 0;
  for (let i = 0; i < 2000; i++) {
    const t = templatesA[Math.floor(rnd() * templatesA.length)];
    const r = run(fullSet(t.kind), '1.1', t.uaStr);
    assert.equal(r.score, 0, `stratum A row ${i} must score 0`);
    if (r.flagged) flagged++;
  }
  assert.equal(flagged / 2000, 0.0);
});

test('stratum B (legacy, seed 20308102): flagged 0.0% and every row scores exactly 2', () => {
  const templatesB = [{ uaStr: UA.chrome70 }, { uaStr: UA.firefox60 }, { uaStr: UA.safari12 }];
  const rnd = mulberry32(20308102);
  let flagged = 0;
  for (let i = 0; i < 2000; i++) {
    const t = templatesB[Math.floor(rnd() * templatesB.length)];
    const h = fullSet('none');
    const r = run(h, '1.1', t.uaStr);
    assert.equal(r.score, 2, `stratum B row ${i} must score exactly 2 (no_sec_fetch alone)`);
    assert.deepEqual(r.codes, ['no_sec_fetch']);
    if (r.flagged) flagged++;
  }
  assert.equal(flagged / 2000, 0.0);
});

// ---------- attack shapes A1-A5, lifted from uas01.cjs ----------
test('A1 curl defaults + Chrome UA: V1 = 10, flagged', () => {
  const r = run({ 'accept': '*/*', 'connection': 'keep-alive' }, '1.1', UA.chrome120);
  assert.deepEqual(sorted(r.codes), sorted(['accept_star', 'no_accept_encoding', 'no_accept_language', 'no_sec_fetch', 'no_client_hints']));
  assert.equal(r.score, 10);
  assert.equal(r.flagged, true);
});

test('A2 python-requests defaults + Chrome UA: V1 = 7, flagged', () => {
  const r = run({ 'accept': '*/*', 'accept-encoding': 'gzip, deflate', 'connection': 'keep-alive' }, '1.1', UA.chrome120);
  assert.deepEqual(sorted(r.codes), sorted(['accept_star', 'no_accept_language', 'no_sec_fetch', 'no_client_hints']));
  assert.equal(r.score, 7);
  assert.equal(r.flagged, true);
});

test('A3 minimal client + Firefox UA, HTTP/1.0: V1 = 11, flagged', () => {
  const r = run({}, '1.0', UA.firefox121);
  assert.deepEqual(sorted(r.codes), sorted(['no_accept', 'no_accept_encoding', 'no_accept_language', 'http_1_0', 'no_sec_fetch']));
  assert.equal(r.score, 11);
  assert.equal(r.flagged, true);
});

test('A4 header-complete spoofer: V1 = 0, no flag (expected miss)', () => {
  const r = run(fullSet('chromium'), '1.1', UA.chrome120);
  assert.equal(r.score, 0);
  assert.deepEqual(r.codes, []);
  assert.equal(r.flagged, false);
});

test('A5 Chrome UA + full headers + From: V1 = 0, no flag (the G3 fix; V0 flagged at exactly 4)', () => {
  const h = fullSet('chromium');
  h['from'] = 'probe@example.com';
  const r = run(h, '1.1', UA.chrome120);
  assert.equal(r.score, 0);
  assert.deepEqual(r.codes, []);
  assert.equal(r.flagged, false);
  assert.equal(r.hasFromHeader, true, 'from_header is reported as a separate boolean in V1');
});
