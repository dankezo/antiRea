'use strict';

// HV-01 x HV-02 escalating VDF ladder (antiRea 3.3.3, opt-in).
// Pins the port of trials-333-hv-composite (vdf_common.py +
// gate_server.py): the frozen T table, the Wesolowski prove /
// verify roundtrip on a real generated RSA-2048 group, the Chaum
// blind-token flow with the 1-token-per-device-per-epoch issuer
// cap, and the ladder flow keyed ONLY by the token serial hash -
// including survival of a full identity reset, which here means a
// second ladder facade over the SAME store with no shared closure
// state (the ladder has no identity input to reset in the first
// place).
//
// RSA-2048 key generation is the slow part: both groups (VDF
// group and the separate issuer key, as in the trial) are
// generated once and reused across every test in this file.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  vdfTTable,
  vdfModpow,
  vdfEval,
  vdfProve,
  vdfVerify,
  fiatShamirL,
  generateVdfGroup,
  tokenMessage,
  serialHash,
  createVdfTokenIssuer,
  createVdfTokenClient,
  parseTokenHeader,
  createInMemoryLadderStore,
  createVdfLadder,
} = require('../dist/tier2-active/vdf-ladder.js');

const vdfGroup = generateVdfGroup();
const issuerKeys = generateVdfGroup();
const issuer = createVdfTokenIssuer({ n: issuerKeys.n, e: issuerKeys.e, d: issuerKeys.d });
const client = createVdfTokenClient({ n: issuerKeys.n, e: issuerKeys.e });

// Mint a token for a device id through the full blind flow and
// return its X-Token header form.
function mintToken(deviceId) {
  const serial = client.generateSerial();
  const { blinded, blindingFactor } = client.blind(serial);
  const issued = issuer.issue(deviceId, blinded);
  assert.equal(issued.ok, true, `issue for ${deviceId} should succeed`);
  const signature = client.unblind(issued.blindedSignature, blindingFactor);
  return { serial, signature, header: client.tokenHeader(serial, signature) };
}

/* ------------------------------------------------------------------ */
/* 1. Frozen table                                                    */
/* ------------------------------------------------------------------ */

test('HV01 ladder: frozen T table matches the trial values exactly', () => {
  const table = vdfTTable(40);
  assert.equal(table.length, 40);
  assert.equal(table[0], 300000n);
  assert.equal(table[6], 730918n);
  assert.equal(table[39], 97945127n);
  assert.equal(table.reduce((a, b) => a + b, 0n), 708227155n);
  // Default argument is the full 40-gate table.
  assert.deepEqual(vdfTTable(), table);
});

/* ------------------------------------------------------------------ */
/* 2. VDF roundtrip on a generated RSA-2048 group                     */
/* ------------------------------------------------------------------ */

test('HV01 ladder: VDF prove / verify roundtrip with small T, tampering rejected', () => {
  const N = vdfGroup.n;
  const serial = client.generateSerial();
  const x = vdfModpow(2n, 123456789n, N);
  const T = 2000n;
  const gate = 3;

  const proof = vdfProve(x, T, serial, gate, N);
  assert.equal(proof.y, vdfEval(x, T, N), 'prove y must equal vdfEval(x, T, N)');
  assert.equal(proof.l, fiatShamirL(x, proof.y, T, serial, gate));
  assert.equal(vdfVerify(x, proof.y, proof.pi, T, serial, gate, N), true);

  // Tampered pi.
  assert.equal(vdfVerify(x, proof.y, proof.pi + 1n, T, serial, gate, N), false);
  // Wrong gate (l is bound to the gate).
  assert.equal(vdfVerify(x, proof.y, proof.pi, T, serial, gate + 1, N), false);
  // Wrong serial (l is bound to the serial).
  const otherSerial = client.generateSerial();
  assert.equal(vdfVerify(x, proof.y, proof.pi, T, otherSerial, gate, N), false);
});

/* ------------------------------------------------------------------ */
/* 3. Blind token flow                                                */
/* ------------------------------------------------------------------ */

test('HV01 ladder: blind token flow, forgery, per-device cap and epoch rotation', () => {
  const { serial, signature, header } = mintToken('device-token-flow');
  assert.equal(issuer.verifyToken(serial, signature), true);
  assert.equal(tokenMessage(serial) > 0n, true);
  assert.match(serialHash(serial), /^[0-9a-f]{64}$/);

  // Forged signature: a random bigint does not verify.
  const forged = vdfModpow(987654321n, 1n, issuerKeys.n);
  assert.equal(issuer.verifyToken(serial, forged), false);

  // Second issue for the same device in the same epoch -> 429.
  const { blinded } = client.blind(client.generateSerial());
  const again = issuer.issue('device-token-flow', blinded);
  assert.deepEqual(again, { ok: false, status: 429, error: 'device_already_minted' });

  // After rotateEpoch the same device can mint again.
  const before = issuer.epoch;
  assert.equal(issuer.rotateEpoch(), before + 1);
  const afterRotate = issuer.issue('device-token-flow', blinded);
  assert.equal(afterRotate.ok, true);

  // Header round-trip and malformed headers. (Byte comparison:
  // node:crypto randomBytes returns a Buffer while the parser
  // returns a plain Uint8Array, so deepStrictEqual on the objects
  // would fail on the prototype alone.)
  const roundTripped = parseTokenHeader(header);
  assert.notEqual(roundTripped, null);
  assert.deepEqual(Buffer.from(roundTripped.serial), Buffer.from(serial));
  assert.equal(roundTripped.signature, signature);
  assert.equal(parseTokenHeader('garbage'), null);
  assert.equal(parseTokenHeader(''), null);
  assert.equal(parseTokenHeader('zz:123'), null);
  assert.equal(parseTokenHeader('aabb:notanumber'), null);
  assert.equal(parseTokenHeader(null), null);
  assert.equal(parseTokenHeader(undefined), null);
});

/* ------------------------------------------------------------------ */
/* 4. Ladder flow, identity reset survival, frozen-on-bad-proof       */
/* ------------------------------------------------------------------ */

const TOY_TABLE = [1000n, 2000n, 3000n, 4000n, 5000n, 6000n, 7000n];

function makeLadder(store, extra = {}) {
  return createVdfLadder({
    group: { n: vdfGroup.n, g: 2n },
    verifyToken: (serial, signature) => issuer.verifyToken(serial, signature),
    tTable: TOY_TABLE,
    store,
    ...extra,
  });
}

test('HV01 ladder: sequential gates, identity reset survival, replay and bad proof handling', () => {
  const store = createInMemoryLadderStore();
  const ladder = makeLadder(store);
  const { header } = mintToken('device-ladder-main');

  // No token and forged token -> 401.
  assert.deepEqual(ladder.challenge(undefined), { status: 401, error: 'bad token' });
  assert.deepEqual(ladder.challenge('deadbeef:12345'), { status: 401, error: 'bad token' });
  assert.deepEqual(ladder.status('deadbeef:12345'), { status: 401, error: 'bad token' });

  // Redeem with no pending challenge -> 409 (fresh token).
  const fresh = mintToken('device-ladder-fresh');
  assert.deepEqual(
    ladder.redeem(fresh.header, { y: '1', pi: '1' }),
    { status: 409, error: 'no pending challenge' },
  );

  // Pay gates 1..6 sequentially, saving gate 1's proof for the
  // replay check below.
  let gate1Proof = null;
  for (let gate = 1; gate <= 6; gate++) {
    const challenge = ladder.challenge(header);
    assert.equal(challenge.gate, gate);
    assert.equal(challenge.T, TOY_TABLE[gate - 1].toString(10));
    const parsed = parseTokenHeader(header);
    const proof = vdfProve(BigInt(challenge.x), BigInt(challenge.T), parsed.serial, gate, vdfGroup.n);
    if (gate === 1) gate1Proof = { y: proof.y.toString(10), pi: proof.pi.toString(10) };
    const redeemed = ladder.redeem(header, { y: proof.y.toString(10), pi: proof.pi.toString(10) });
    assert.equal(redeemed.status, 200);
    assert.equal(redeemed.gatesPaid, gate);
  }
  assert.deepEqual(ladder.status(header), { status: 200, gatesPaid: 6 });

  // FULL identity reset: a second ladder facade over the SAME
  // store, sharing nothing but the store itself. The next
  // challenge must be gate 7 at the toy table's tier 7 - the
  // ladder position survived because it is keyed only to the
  // token serial hash.
  const ladderAfterReset = makeLadder(store);
  const next = ladderAfterReset.challenge(header);
  assert.equal(next.status, 200);
  assert.equal(next.gate, 7);
  assert.equal(next.T, '7000');

  // Replay: gate 1's proof against gate 7's challenge -> 403, and
  // the ladder stays frozen (gatesPaid unchanged, pending kept).
  assert.deepEqual(ladderAfterReset.redeem(header, gate1Proof), { status: 403, error: 'bad proof' });
  assert.deepEqual(ladderAfterReset.status(header), { status: 200, gatesPaid: 6 });

  // Bad proof -> 403, ladder frozen, then the correct proof for
  // the still-pending challenge succeeds (not bricked).
  assert.deepEqual(
    ladderAfterReset.redeem(header, { y: '42', pi: '42' }),
    { status: 403, error: 'bad proof' },
  );
  assert.deepEqual(ladderAfterReset.status(header), { status: 200, gatesPaid: 6 });
  const parsed = parseTokenHeader(header);
  const proof7 = vdfProve(BigInt(next.x), BigInt(next.T), parsed.serial, 7, vdfGroup.n);
  const redeemed7 = ladderAfterReset.redeem(header, {
    y: proof7.y.toString(10),
    pi: proof7.pi.toString(10),
  });
  assert.equal(redeemed7.status, 200);
  assert.equal(redeemed7.gatesPaid, 7);

  // Ladder complete: all toy gates paid.
  assert.deepEqual(ladderAfterReset.challenge(header), { status: 409, error: 'ladder complete' });

  // A second token (different serial) starts at gate 1
  // independently of the first token's position.
  const second = mintToken('device-ladder-second');
  const firstChallenge = ladder.challenge(second.header);
  assert.equal(firstChallenge.status, 200);
  assert.equal(firstChallenge.gate, 1);
  assert.equal(firstChallenge.T, '1000');
  assert.deepEqual(ladder.status(second.header), { status: 200, gatesPaid: 0 });
});

test('HV01 ladder: onGatePaid hook receives (serialHash, gate) and its value is the batch', () => {
  const store = createInMemoryLadderStore();
  const calls = [];
  const ladder = makeLadder(store, {
    onGatePaid: (key, gate) => {
      calls.push([key, gate]);
      return `batch-${gate}`;
    },
  });
  const { serial, header } = mintToken('device-ladder-hook');
  const challenge = ladder.challenge(header);
  const proof = vdfProve(BigInt(challenge.x), BigInt(challenge.T), serial, challenge.gate, vdfGroup.n);
  const redeemed = ladder.redeem(header, { y: proof.y.toString(10), pi: proof.pi.toString(10) });
  assert.equal(redeemed.status, 200);
  assert.equal(redeemed.batch, 'batch-1');
  assert.deepEqual(calls, [[serialHash(serial), 1]]);
});

/* ------------------------------------------------------------------ */
/* 5. Exemption                                                       */
/* ------------------------------------------------------------------ */

test('HV01 ladder: exempt token short-circuits challenge and writes no state', () => {
  const store = createInMemoryLadderStore();
  const { serial, header } = mintToken('device-ladder-exempt');
  const key = serialHash(serial);
  const ladder = makeLadder(store, { isExempt: (candidate) => candidate === key });
  assert.deepEqual(ladder.challenge(header), { status: 200, exempt: true, gatesPaid: 0 });
  assert.equal(store.get(key), undefined, 'exempt challenge must not write ladder state');

  // A non-exempt token on the same ladder is unaffected.
  const other = mintToken('device-ladder-nonexempt');
  const challenge = ladder.challenge(other.header);
  assert.equal(challenge.status, 200);
  assert.equal(challenge.gate, 1);
});
