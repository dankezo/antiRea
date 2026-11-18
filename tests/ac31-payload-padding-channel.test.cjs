const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-31 (PASS-LAB, L3 only, ac-batch1-lab): attribution 3/3;
// survives repackaging, NOT regeneration (documented in the
// module). L1 / L2 / L3b are measured dead and are not built.

// A data payload: 64 bytes of content, then a 64-byte padding
// region (zeros) the payload format ignores.
function payload() {
  const bytes = new Uint8Array(128);
  for (let i = 0; i < 64; i++) bytes[i] = (i * 7) % 251;
  return { payload: bytes, paddingOffset: 64, paddingLength: 64 };
}

test('AC-31: attribution is 3/3 across the lab channels (web / store / partner)', () => {
  for (const channel of ['web', 'store', 'partner']) {
    const region = payload();
    const markedBytes = sdk.embedPaddingChannel(region, channel);
    const extracted = sdk.extractPaddingChannel({ ...region, payload: markedBytes });
    assert.equal(extracted, channel);
  }
});

test('AC-31: the mark survives repackaging (bytes copied into a new container)', () => {
  const region = payload();
  const markedBytes = sdk.embedPaddingChannel(region, 'web');
  const container = new Uint8Array(256);
  container.set(markedBytes, 100);
  const extracted = sdk.extractPaddingChannel({
    payload: container,
    paddingOffset: 100 + region.paddingOffset,
    paddingLength: region.paddingLength,
  });
  assert.equal(extracted, 'web');
});

test('AC-31: the mark does NOT survive regeneration (documented scope limit)', () => {
  const fresh = payload();
  assert.equal(sdk.extractPaddingChannel(fresh), null);
});

test('AC-31: corrupted padding extracts null, and embed validates its inputs', () => {
  const region = payload();
  const markedBytes = sdk.embedPaddingChannel(region, 'store');
  markedBytes[region.paddingOffset + 6] ^= 0xff; // corrupt the id
  assert.equal(sdk.extractPaddingChannel({ ...region, payload: markedBytes }), null);
  assert.throws(() => sdk.embedPaddingChannel(region, ''), RangeError);
  assert.throws(
    () => sdk.embedPaddingChannel({ payload: new Uint8Array(16), paddingOffset: 8, paddingLength: 8 }, 'web'),
    RangeError,
  );
  const before = payload();
  const snapshot = Uint8Array.from(before.payload);
  sdk.embedPaddingChannel(before, 'web');
  assert.deepEqual(before.payload, snapshot);
});
