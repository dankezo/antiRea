'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-23 per-identity attribution (3.3.1, B1): the A4 canary-tag
// pattern on the image channel. Payloads are keyed per identity
// (HMAC-SHA256, first 32 bits); the shipped form is Y-DCT only -
// the LSB form was the VIS trial's screenshot-pipeline proof and
// is not shipped (it dies under JPEG compression).

const W = 720;
const H = 360;
const SECRET = 'ac23-attribution-test-secret';
const IDS = ['acct-alpha', 'acct-beta', 'acct-gamma'];

function baseImage() {
  const y = new Float64Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      y[row * W + col] = 128 + 40 * Math.sin(col / 17) + 30 * Math.cos(row / 11) + ((col * row) % 13);
    }
  }
  return { width: W, height: H, y };
}

const markedFor = (identity) => {
  const img = baseImage();
  return { width: W, height: H, y: sdk.embedYDctWatermarkForIdentity(img, SECRET, identity) };
};

test('payloads are deterministic per (secret, identity) and distinct across identities', () => {
  const payloads = IDS.map((id) => sdk.ac23PayloadForIdentity(SECRET, id));
  assert.deepEqual(payloads, IDS.map((id) => sdk.ac23PayloadForIdentity(SECRET, id)));
  assert.equal(new Set(payloads).size, IDS.length);
  assert.notEqual(sdk.ac23PayloadForIdentity('another-secret', IDS[0]), payloads[0]);
});

test('embed for an identity extracts as a full match for that identity only', () => {
  const img = markedFor(IDS[0]);
  const own = sdk.extractYDctWatermarkForIdentity(img, SECRET, IDS[0]);
  assert.equal(own.fullMatch, true);
  assert.equal(own.payload, sdk.ac23PayloadForIdentity(SECRET, IDS[0]));
  const other = sdk.extractYDctWatermarkForIdentity(img, SECRET, IDS[1]);
  assert.equal(other.fullMatch, false);
});

test('attribution names the serving identity from the candidate set', () => {
  const img = markedFor(IDS[1]);
  const hit = sdk.identifyYDctWatermark(img, SECRET, IDS);
  assert.ok(hit);
  assert.equal(hit.identity, IDS[1]);
  assert.equal(hit.extraction.fullMatch, true);
  assert.equal(sdk.identifyYDctPayload(sdk.ac23PayloadForIdentity(SECRET, IDS[2]), SECRET, IDS), IDS[2]);
});

test('attribution refuses strangers: unknown candidate set, wrong secret, clean image', () => {
  const img = markedFor(IDS[0]);
  assert.equal(sdk.identifyYDctWatermark(img, SECRET, ['acct-delta', 'acct-epsilon']), null);
  assert.equal(sdk.identifyYDctWatermark(img, 'wrong-secret', IDS), null);
  assert.equal(sdk.identifyYDctWatermark(baseImage(), SECRET, IDS), null);
});

test('the generic (non-identity) payload path still works side by side', () => {
  const img = baseImage();
  const marked = { width: W, height: H, y: sdk.embedYDctWatermark(img, 0xac23a517) };
  const result = sdk.extractYDctWatermark(marked, { expectedPayload: 0xac23a517 });
  assert.equal(result.fullMatch, true);
});
