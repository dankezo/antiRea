const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const ORDINARY = ['/', '/about', '/blog/post'];
const BROWSERS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  'curl/8.4.0', 'Wget/1.21.4', 'python-requests/2.31.0', 'Go-http-client/1.1',
  'PostmanRuntime/7.36.0', 'okhttp/4.12.0', 'Java/17.0.9', 'node-fetch',
  'Mozilla/5.0 (compatible; SemrushBot/7~bl)', 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0',
];

test('RSP-14 all 10 markers flag on a secret path, none on ordinary paths (30 checks)', () => {
  let flagged = 0;
  for (const m of sdk.RSP_CRAWLER_MARKERS) if (sdk.rspCrawlerImpersonation(`Mozilla/5.0 (compatible; ${m}/1.0)`, '/.env').flagged) flagged++;
  assert.equal(flagged, 10);
  let ordinaryFlags = 0;
  for (const m of sdk.RSP_CRAWLER_MARKERS) for (const p of ORDINARY) if (sdk.rspCrawlerImpersonation(m, p).flagged) ordinaryFlags++;
  assert.equal(ordinaryFlags, 0);
});

test('RSP-14 browser and tool UAs unflagged on secret paths (14/14)', () => {
  assert.equal(BROWSERS.length, 14);
  let unflagged = 0;
  for (const ua of BROWSERS) if (!sdk.rspCrawlerImpersonation(ua, '/.env').flagged) unflagged++;
  assert.equal(unflagged, 14);
});

test('RSP-14 case-insensitive matching (2/2)', () => {
  assert.equal(sdk.rspCrawlerImpersonation('PERPLEXITYBOT', '/.env').flagged, true);
  assert.equal(sdk.rspCrawlerImpersonation('Perplexitybot', '/.git/config').flagged, true);
});
