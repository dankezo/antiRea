const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// AC-23 (PASS-LAB, Y-DCT form ONLY, ac-batch2-lab): extracts 32/32
// full match on RIGHT / BOTTOM / TOP placements and survives
// JPEG80; CENTER placement 23/32 in the lab (vote starvation - a
// coverage fact). Blue-DCT and LSB forms are KILL-confirmed and
// are NOT built. No clean-image false-match rate is claimed: the
// lab record does not contain one.

const W = 720;
const H = 360;
const PAYLOAD = 0xac23a517;

function baseImage() {
  // A smooth luminance plane with enough texture for DCT blocks.
  const y = new Float64Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      y[row * W + col] = 128 + 40 * Math.sin(col / 17) + 30 * Math.cos(row / 11) + ((col * row) % 13);
    }
  }
  return { width: W, height: H, y };
}

const marked = () => {
  const img = baseImage();
  return { width: W, height: H, y: sdk.embedYDctWatermark(img, PAYLOAD) };
};

test('AC-23: full-frame extraction is a 32/32 full match', () => {
  const result = sdk.extractYDctWatermark(marked(), { expectedPayload: PAYLOAD });
  assert.equal(result.correctBits, 32);
  assert.equal(result.fullMatch, true);
  assert.equal(result.payload, PAYLOAD);
  assert.equal(result.belowQuorumBits.length, 0);
});

for (const [name, region] of [
  ['RIGHT', { x0: 390, x1: W, y0: 0, y1: H }],
  ['BOTTOM', { x0: 0, x1: W, y0: 180, y1: H }],
  ['TOP', { x0: 0, x1: W, y0: 0, y1: 180 }],
]) {
  test(`AC-23: ${name} placement extracts 32/32 full match`, () => {
    const result = sdk.extractYDctWatermark(marked(), { region, expectedPayload: PAYLOAD });
    assert.equal(result.correctBits, 32, `${name}: ${JSON.stringify(result.repeatsPerBit)}`);
    assert.equal(result.fullMatch, true);
  });
}

test('AC-23: CENTER placement suffers vote starvation (coverage fact, not signal death)', () => {
  const center = { x0: 180, x1: 540, y0: 90, y1: 270 };
  const result = sdk.extractYDctWatermark(marked(), { region: center, expectedPayload: PAYLOAD });
  // The lab measured 23/32 at CENTER with 9 bits below quorum. Our
  // block selection differs from the lab seed stream, so the pin is
  // the mechanism: some bits fall below quorum in the center
  // quarter and the extraction is not a full match.
  assert.ok(result.belowQuorumBits.length > 0, 'expected below-quorum bits at CENTER');
  assert.equal(result.fullMatch, false);
});

test('AC-23: extraction survives a JPEG-like lossy step (quantized luminance)', () => {
  const img = marked();
  // A coarse lossy proxy: quantize luminance to steps of 4, which
  // is far gentler than JPEG80's DCT quantization on the marked
  // coefficients; the lab's JPEG80 survival itself is on record.
  const degraded = {
    width: W,
    height: H,
    y: Float64Array.from(img.y, v => Math.round(v / 4) * 4),
  };
  const result = sdk.extractYDctWatermark(degraded, { expectedPayload: PAYLOAD });
  assert.equal(result.correctBits, 32);
  assert.equal(result.fullMatch, true);
});

test('AC-23: only the Y-DCT form exists - no Blue-DCT or LSB exports', () => {
  const names = Object.keys(sdk);
  assert.equal(names.some(n => /blue/i.test(n) && /watermark|dct/i.test(n)), false);
  assert.equal(names.some(n => /lsb/i.test(n)), false);
  assert.equal(typeof sdk.embedYDctWatermark, 'function');
  assert.equal(typeof sdk.extractYDctWatermark, 'function');
  assert.equal(sdk.AC23_QUORUM, 10);
  assert.equal(sdk.AC23_REPEATS_PER_BIT, 48);
});
