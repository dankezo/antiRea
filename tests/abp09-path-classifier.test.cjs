const { test } = require('node:test');
const assert = require('node:assert/strict');
// ABP-09 NON-APP-PATHS-MUST-BE-CLASSIFIED-BEFORE-SCORING: in the
// neighbour, unclassified non-app paths fed scanner scoring
// directly - 11 unique typo paths fast scored 38 (challenge band),
// ONE repeated typo path fast scored 23 on velocity alone (also
// challenge band), and 11 locale-prefixed app routes scored like
// typos (38). antiRea form: an opt-in, velocity-blind classifier
// ahead of scanner-path scoring; only the probe class feeds
// scanner signals.
const sdk = require('../dist/index.js');

const APP_PATHS = ['/home', '/about', '/contact', '/products', '/dashboard', '/api/items'];
const classifier = sdk.createPathClassifier({ appPaths: APP_PATHS });

test('app paths classify as app and never feed scanner signals', () => {
  for (const p of APP_PATHS) {
    const c = classifier.classify(p);
    assert.equal(c.class, 'app', p);
    assert.equal(c.feedsScannerSignal, false, p);
  }
  assert.equal(classifier.classify('/products/42').class, 'app'); // nested under an app path
});

test('lab typo fixture: 11 unique typo paths classify as typo, not probe', () => {
  const typos = ['/hme', '/hom', '/abou', '/aboutt', '/contac', '/contactt', '/produts', '/dashbord', '/dashboar', '/api/item', '/api/itms'];
  assert.equal(typos.length, 11);
  for (const p of typos) {
    const c = classifier.classify(p);
    assert.equal(c.class, 'typo', p + ' -> ' + c.class);
    assert.equal(c.feedsScannerSignal, false, p);
    assert.ok(APP_PATHS.includes(c.matchedAppPath), p);
  }
});

test('velocity cannot change a class: one repeated typo path, 23 fast repeats, stays typo', () => {
  // The lab's velocity-alone fixture (score 23, challenge band).
  // The classifier takes no timing or count input, so repetition
  // is not merely discounted - it is unrepresentable.
  for (let i = 0; i < 23; i++) {
    const c = classifier.classify('/hme');
    assert.equal(c.class, 'typo');
    assert.equal(c.feedsScannerSignal, false);
  }
});

test('lab locale fixture: locale-prefixed app routes classify as locale_route, not typo', () => {
  const locales = ['/vi/home', '/en/home', '/vi/about', '/en/products', '/vi/contact', '/en/dashboard', '/vi/api/items', '/en/about', '/vi/products', '/en/contact', '/vi/dashboard'];
  assert.equal(locales.length, 11);
  for (const p of locales) {
    const c = classifier.classify(p);
    assert.equal(c.class, 'locale_route', p + ' -> ' + c.class);
    assert.equal(c.feedsScannerSignal, false, p);
    assert.ok(APP_PATHS.includes(c.matchedAppPath), p);
  }
  assert.equal(classifier.classify('/vi/home').locale, 'vi');
});

test('a locale prefix over a non-app remainder is not a locale route', () => {
  const c = classifier.classify('/vi/definitely-not-a-page');
  assert.notEqual(c.class, 'locale_route');
  assert.equal(c.feedsScannerSignal, false);
});

test('probe paths classify as probe and are the only scanner-feeding class', () => {
  for (const p of ['/.env', '/.git/config', '/wp-login.php', '/phpinfo.php', '/.git/HEAD', '/actuator/env', '/api/v1/internal/schema-export']) {
    const c = classifier.classify(p);
    assert.equal(c.class, 'probe', p + ' -> ' + c.class);
    assert.equal(c.feedsScannerSignal, true, p);
  }
});

test('asset paths classify as asset', () => {
  for (const p of ['/assets/app.css', '/static/site.js', '/logo.png', '/favicon.ico', '/fonts/main.woff2']) {
    const c = classifier.classify(p);
    assert.equal(c.class, 'asset', p + ' -> ' + c.class);
    assert.equal(c.feedsScannerSignal, false, p);
  }
});

test('unrecognized non-app paths are unknown_non_app: recorded, not scored', () => {
  const c = classifier.classify('/api/v2/users');
  assert.equal(c.class, 'unknown_non_app');
  assert.equal(c.feedsScannerSignal, false);
  assert.equal(classifier.classify('/totally/different/place').class, 'unknown_non_app');
});

test('classification is query, case and trailing-slash stable', () => {
  assert.equal(classifier.classify('/HOME?utm_source=x').class, 'app');
  assert.equal(classifier.classify('/vi/HOME/').class, 'locale_route');
  assert.equal(classifier.classify('/.env?x=1').class, 'probe');
});

test('construction without app paths is refused (a classifier with no app surface classifies nothing honestly)', () => {
  assert.throws(() => sdk.createPathClassifier({ appPaths: [] }), TypeError);
  assert.throws(() => sdk.createPathClassifier({}), TypeError);
});
