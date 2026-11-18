const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ABS-07: a path-prefix list must never contain "/" as a browser-path
// prefix. Neighbour measurement (abs-lab RESULTS-ABS-STEP0): with "/"
// in the list, python-requests on /api/data scored exactly 40 via the
// "/" prefix; without it the same request scored 20; real browser
// headers scored 0. The "/" entry is what widened the match surface
// to every path.

test('ABS-07: validateBrowserPathPrefixes rejects the root prefix "/"', () => {
  assert.throws(() => sdk.validateBrowserPathPrefixes(['/']), sdk.BrowserPathPrefixError);
  assert.throws(() => sdk.validateBrowserPathPrefixes(['/api', '/']), /forbidden/);
});

test('ABS-07: disguised root prefixes ("//", "/?x", trailing forms) are rejected after normalization', () => {
  assert.throws(() => sdk.validateBrowserPathPrefixes(['//']), sdk.BrowserPathPrefixError);
  assert.throws(() => sdk.validateBrowserPathPrefixes(['/?utm=1']), sdk.BrowserPathPrefixError);
});

test('ABS-07: valid prefixes normalize and dedupe', () => {
  assert.deepEqual(sdk.validateBrowserPathPrefixes(['/api/', '/API', '/app']), ['/api', '/app']);
  assert.deepEqual(sdk.validateBrowserPathPrefixes([]), []);
});

test('ABS-07: matcher matches on segment boundaries only', () => {
  assert.equal(sdk.isBrowserPath('/api/data', ['/api']), true);
  assert.equal(sdk.isBrowserPath('/api', ['/api']), true);
  assert.equal(sdk.isBrowserPath('/apiary', ['/api']), false);
  assert.equal(sdk.isBrowserPath('/other', ['/api']), false);
});

test('ABS-07: matcher refuses a list carrying "/" instead of matching everything', () => {
  // The neighbour bug in one line: with "/" accepted, /api/data (and
  // every other path) is a "browser path". Here the call throws.
  assert.throws(() => sdk.isBrowserPath('/api/data', ['/']), sdk.BrowserPathPrefixError);
  assert.throws(() => sdk.isBrowserPath('/anything/at/all', ['/']), sdk.BrowserPathPrefixError);
});

test('ABS-07: non-string and empty entries are rejected', () => {
  assert.throws(() => sdk.validateBrowserPathPrefixes(['']), sdk.BrowserPathPrefixError);
  assert.throws(() => sdk.validateBrowserPathPrefixes([42]), sdk.BrowserPathPrefixError);
});
