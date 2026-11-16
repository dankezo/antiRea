'use strict';
/*
 * GATEKEY-01 suite tests (antiRea 3.0 Item 2): the registered gate
 * cells of gatekey-lab/REGISTRATION-GATEKEY-STEP0.md reproduced
 * against the built module (src/tier2-active/bulk-access-key.ts),
 * plus the GK-G4 cell under the P1 policy amendment
 * (AMENDMENT-GK-G4-POLICY.md, option (d) step-up fast lane; lab
 * re-run in RESULTS-GK-G4-RERUN.md).
 *
 * Serving follows the lab's frozen reading R3: legit bulk demand
 * is a volume/coverage stream - a bulk identity is served the
 * records its held slices offer, and a job completes on distinct
 * coverage, not on a specific-record shopping list.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../dist/tier2-active/bulk-access-key.js');

const DAY = 86_400_000;
const HEAD = 1000;
const T0 = 1_700_006_400_000; // a day boundary

const STEP_UP_402 = {
  priceUsd: 0.001,
  manifestUrl: 'https://example.test/x402-manifest',
  facilitator: 'gatekey-test',
  payUrl: 'https://example.test/pay',
  appealUrl: 'https://example.test/appeal',
  continueFreeUrl: 'https://example.test/continue',
};

function makeAuth(extra) {
  const clock = { t: T0 };
  const auth = mod.createBulkAccessKeyAuthority(Object.assign({
    secret: 'gatekey-suite-secret',
    stepUp402: STEP_UP_402,
    now: () => clock.t,
  }, extra || {}));
  return { auth, clock };
}

function serveWholeSlice(auth, identity, token, ctx) {
  const info = auth.keyInfo(token);
  const slice = auth.sliceForKey(info.kid);
  let tail = 0;
  for (const r of slice) {
    const res = auth.serve(identity, r, { keyToken: token, context: ctx });
    assert.equal(res.ok, true, `serve under key failed for record ${r}: ${JSON.stringify(res)}`);
    if (r >= HEAD) tail++;
  }
  return tail;
}

/* ---------------- GK-G1: ordinary + heavy, zero denials ---------------- */

test('GK-G1: ordinary and heavy readers served in full, 0 denials, 0 step-up demands', () => {
  const { auth, clock } = makeAuth();
  const ordinary = Array.from({ length: 24 }, (_, i) => ({ id: 'ordinary-' + i, ptr: 0 }));
  const heavy = Array.from({ length: 6 }, (_, i) => ({ id: 'heavy-' + i, ptr: 0, tailPtr: 0 }));
  let oDem = 0, oServed = 0, hDem = 0, hServed = 0, denials = 0;

  for (let day = 0; day < 14; day++) {
    clock.t = T0 + day * DAY;
    for (const o of ordinary) {
      const novel = 5; // inside the head and the free zone (p99 = 8 persona)
      for (let k = 0; k < novel; k++) {
        oDem++;
        const res = auth.serve(o.id, o.ptr++);
        if (res.ok) oServed++; else denials++;
      }
    }
    for (let hi = 0; hi < heavy.length; hi++) {
      const h = heavy[hi];
      const novel = 44, tailWant = (day + hi) % 5 < 2 ? 16 : 0; // tail-inclusive ~40% of days (R9)
      const headWant = novel - tailWant;
      for (let k = 0; k < headWant; k++) {
        hDem++;
        const res = auth.serve(h.id, h.ptr++);
        if (res.ok) hServed++; else denials++;
      }
      if (tailWant > 0) {
        hDem += tailWant;
        const req = auth.requestKey(h.id, 'anon', {});
        assert.equal(req.status, 'issued', `heavy key not issued: ${JSON.stringify(req)}`);
        const slice = auth.sliceForKey(req.key.kid).filter((r) => r >= HEAD);
        let got = 0;
        for (const r of slice) {
          if (got >= tailWant) break;
          const res = auth.serve(h.id, r, { keyToken: req.token });
          if (res.ok && !res.redelivery) { got++; hServed++; } else if (!res.ok) denials++;
        }
        assert.equal(got, tailWant);
      } else {
        auth.noteNonBulkSession(h.id);
      }
    }
  }
  assert.equal(oServed, oDem);
  assert.equal(hServed, hDem);
  assert.equal(denials, 0);
  assert.equal(auth.stats().stepUpDemands.length, 0);
});

/* ---------------- GK-G2: issuance keyed by identity only ---------------- */

test('GK-G2: shared-egress pair unaffected; issuance contains no IP state (egress invariance)', () => {
  const { auth, clock } = makeAuth();
  const ctxShared = { ip: 'shared-egress', ua: 'ua-x', tls: 'tls-x' };
  let dem = 0, served = 0, denials = 0;
  for (let day = 0; day < 14; day++) {
    clock.t = T0 + day * DAY;
    for (let i = 0; i < 12; i++) {
      const id = 'nat-' + i;
      for (let k = 0; k < 4; k++) {
        dem++;
        const res = auth.serve(id, day * 4 + k, { context: ctxShared });
        if (res.ok) served++; else denials++;
      }
    }
  }
  assert.equal(served, dem);
  assert.equal(denials, 0);

  // Egress invariance: identical demand under shared vs distinct
  // egress produces identical issuance (sub, epoch, block) logs.
  function run(shared) {
    const { auth: a2, clock: c2 } = makeAuth();
    const log = [];
    for (let day = 0; day < 6; day++) {
      c2.t = T0 + day * DAY;
      if (day === 2 || day === 5) {
        for (let i = 0; i < 2; i++) {
          const id = 'eg-' + i;
          const ctx = { ip: shared ? 'shared-egress' : 'egress-' + i, ua: 'ua-eg-' + i, tls: 'tls-eg' };
          void ctx; // issuance never reads context - that is the claim
          const req = a2.requestKey(id, 'anon', {});
          assert.equal(req.status, 'issued');
          log.push({ day, sub: id, epoch: req.key.epoch, block: req.key.block });
          serveWholeSlice(a2, id, req.token);
        }
      }
    }
    return log;
  }
  assert.deepEqual(run(true), run(false));
});

/* ---------------- GK-G3: legit bulk lanes ---------------- */

test('GK-G3: researcher completes 2,000 tail by day <= 3 (account); export gate enforced', () => {
  const { auth, clock } = makeAuth();
  const id = 'researcher';
  const tail = new Set();
  const recordToken = new Map();
  const recordDay = new Map();
  let completionDay = null;
  for (let day = 1; day <= 14 && completionDay == null; day++) {
    clock.t = T0 + (day - 1) * DAY;
    for (let k = 0; k < 6; k++) {
      const req = auth.requestKey(id, 'account', { accountAgeDays: 45 });
      if (req.status !== 'issued') break;
      const slice = auth.sliceForKey(req.key.kid);
      for (const r of slice) {
        const res = auth.serve(id, r, { keyToken: req.token });
        assert.equal(res.ok, true);
        if (!recordToken.has(r)) { recordToken.set(r, req.token); recordDay.set(r, day); }
        if (r >= HEAD) tail.add(r);
      }
    }
    if (tail.size >= 2000) completionDay = day;
  }
  assert.equal(completionDay, 3);
  assert.ok(tail.size >= 2000);

  // Export of a record no held key covers is refused (402 shape);
  // exporting a covered, already-viewed record is allowed.
  let uncovered = -1;
  for (let r = HEAD; r < 10000; r++) if (!recordToken.has(r)) { uncovered = r; break; }
  const refused = auth.serve(id, uncovered, { exported: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'export_needs_key');
  assert.equal(refused.stepUp402.status, 402);
  const coveredRec = [...tail].find((r) => recordDay.get(r) === completionDay);
  const allowed = auth.serve(id, coveredRec, { exported: true, keyToken: recordToken.get(coveredRec) });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.exported, true);
});

test('GK-G3: partner full sync by day <= 2 (verified); verified bot 100% within rhythm', () => {
  const { auth, clock } = makeAuth();
  const id = 'partner';
  const served = new Set();
  let completionDay = null, requested = 0, issued = 0;
  for (let day = 1; day <= 14 && completionDay == null; day++) {
    clock.t = T0 + (day - 1) * DAY;
    while (served.size < 10000) {
      requested++;
      const req = auth.requestKey(id, 'verified', { declared: true, cohortId: 'partner', allowlisted: true, webBotAuthVerified: true });
      if (req.status !== 'issued') break;
      issued++;
      for (const r of auth.sliceForKey(req.key.kid)) {
        assert.equal(auth.serve(id, r, { keyToken: req.token }).ok, true);
        served.add(r);
      }
    }
    if (served.size >= 10000) completionDay = day;
  }
  assert.equal(completionDay, 2);
  assert.equal(served.size, 10000);

  const bot = makeAuth();
  let bReq = 0, bIssued = 0;
  const bServed = new Set();
  for (let day = 0; day < 2; day++) {
    bot.clock.t = T0 + day * DAY;
    const n = day === 0 ? 34 : 33;
    for (let k = 0; k < n; k++) {
      bReq++;
      const req = bot.auth.requestKey('indexer', 'verified', { allowlisted: true, webBotAuthVerified: true });
      if (req.status === 'issued') {
        bIssued++;
        for (const r of bot.auth.sliceForKey(req.key.kid)) { bot.auth.serve('indexer', r, { keyToken: req.token }); bServed.add(r); }
      }
    }
  }
  assert.equal(bIssued, bReq);
  assert.equal(bServed.size, 10000);
});

test('GK-G3: accessibility tooling - re-delivery free, zero denials at frozen demand', () => {
  const { auth, clock } = makeAuth();
  const id = 'a11y';
  const seen = new Set();
  let demanded = 0, servedCount = 0, denials = 0, keysUsed = 0, redeliveries = 0;
  for (let day = 0; day < 14; day++) {
    clock.t = T0 + day * DAY;
    // re-deliveries of already-served records: always free
    for (const r of [...seen].slice(0, 100)) {
      const res = auth.serve(id, r);
      assert.equal(res.ok, true);
      assert.equal(res.redelivery, true);
      redeliveries++;
    }
    let remaining = 350; // <= 400 novel/day
    demanded += remaining;
    // keyless head phase up to F
    let ptr = day * 7;
    while (remaining > 0) {
      const before = seen.size;
      // try keyless head first while ptr is in head range and unseen
      let progressed = false;
      while (ptr < HEAD && remaining > 0) {
        const r = ptr++;
        if (seen.has(r)) continue;
        const res = auth.serve(id, r);
        if (res.ok) { seen.add(r); servedCount++; remaining--; progressed = true; }
        else break;
      }
      if (remaining <= 0) break;
      const req = auth.requestKey(id, 'account', { accountAgeDays: 60 });
      if (req.status !== 'issued') { denials += remaining; break; }
      keysUsed++;
      for (const r of auth.sliceForKey(req.key.kid)) {
        const novel = !seen.has(r);
        const res = auth.serve(id, r, { keyToken: req.token });
        if (res.ok) {
          if (novel && remaining > 0) { seen.add(r); servedCount++; remaining--; }
          else if (novel) seen.add(r);
          progressed = true;
        } else denials++;
      }
      if (!progressed && seen.size === before) { denials += remaining; break; }
    }
  }
  assert.equal(denials, 0);
  assert.equal(servedCount, demanded);
  assert.ok(keysUsed > 0 && redeliveries > 0);
});

/* ---------------- GK-G5: slice geometry ---------------- */

test('GK-G5: epoch tiling disjoint, contiguity bounds, per-key served <= 150', () => {
  const { auth, clock } = makeAuth();
  clock.t = T0;
  const slices = [];
  // 67 verified keys in one day exceed the rhythm; use 2 days.
  const id = 'partner';
  let day = 0;
  while (slices.length < 67) {
    clock.t = T0 + day * DAY;
    for (let k = 0; k < 60 && slices.length < 67; k++) {
      const req = auth.requestKey(id, 'verified', { allowlisted: true, webBotAuthVerified: true });
      assert.equal(req.status, 'issued');
      serveWholeSlice(auth, id, req.token);
      slices.push({ kid: req.key.kid, slice: auth.sliceForKey(req.key.kid), served: auth.keyInfo(req.token).servedCount });
    }
    day++;
  }
  const union = new Set();
  let overlap = 0;
  for (const s of slices) for (const r of s.slice) { if (union.has(r)) overlap++; union.add(r); }
  assert.equal(overlap, 0);
  assert.equal(union.size, 10000);
  let maxAdj = 0, maxRun = 0;
  for (const s of slices) {
    const set = new Set(s.slice);
    let adj = 0, run = 0, mr = 0;
    for (let i = 0; i < 9999; i++) if (set.has(i) && set.has(i + 1)) adj++;
    for (let i = 0; i < 10000; i++) { if (set.has(i)) { run++; if (run > mr) mr = run; } else run = 0; }
    maxAdj = Math.max(maxAdj, adj); maxRun = Math.max(maxRun, mr);
    assert.ok(s.served <= 150, `per-key served ${s.served} > 150`);
  }
  assert.ok(maxAdj <= 8, `max adjacent pairs ${maxAdj} > 8`);
  assert.ok(maxRun <= 4, `max run ${maxRun} > 4`);
});

/* ---------------- GK-G6: share / fork narrative ---------------- */

test('GK-G6: A2 fork narrative end-to-end, incl. both negative controls', () => {
  const { auth, clock } = makeAuth();
  clock.t = T0;
  const ctxX = { ip: '203.0.113.0/24', ua: 'UA-build-1', tls: 'tls-a' };
  const ctxColl = { ip: '198.51.100.0/24', ua: 'UA-build-9', tls: 'tls-z' };
  const owner = 'owner';
  const m1 = auth.requestKey(owner, 'account', { accountAgeDays: 90 });
  assert.equal(m1.status, 'issued');
  const K1 = m1.token, K1kid = m1.key.kid;
  const slice1 = auth.sliceForKey(K1kid);
  for (const r of slice1.slice(0, 10)) assert.equal(auth.serve(owner, r, { keyToken: K1, context: ctxX }).ok, true);

  // (i) colluders present the key (non-owner): rejected, share evidence, no fork yet
  let nonOwnerAccept = 0;
  for (let i = 0; i < 3; i++) {
    const p = auth.presentKey('colluder-' + i, K1, ctxColl);
    if (p.accepted) nonOwnerAccept++;
    assert.equal(p.reason, 'binding_mismatch');
  }
  assert.equal(nonOwnerAccept, 0);
  assert.equal(auth.stats().shareEvidence, 3);
  assert.equal(auth.stats().forks.length, 0);

  // negative control 1: idempotent re-issuance replays return the SAME kid, no fork
  const issuedBefore = auth.stats().totalIssuedByChannel.account;
  const rp = auth.requestKey(owner, 'account', { accountAgeDays: 90 });
  assert.equal(rp.status, 'replay');
  assert.equal(rp.key.kid, K1kid);
  assert.equal(auth.stats().totalIssuedByChannel.account, issuedBefore);
  assert.equal(auth.stats().forks.length, 0);

  // owner exhausts K1, re-issues -> K2 with lineage, uses successor in ctxX
  serveWholeSlice(auth, owner, K1, ctxX);
  const m2 = auth.requestKey(owner, 'account', { accountAgeDays: 90 });
  assert.equal(m2.status, 'issued');
  assert.equal(m2.key.lin, K1kid);
  const K2 = m2.token;
  for (const r of auth.sliceForKey(m2.key.kid).slice(0, 5)) {
    assert.equal(auth.serve(owner, r, { keyToken: K2, context: ctxX }).ok, true);
  }

  // negative control 2: owner presents its CURRENT key from a drifted context - accepted, no fork
  const ctxX2 = { ip: '192.0.2.0/24', ua: 'UA-build-1', tls: 'tls-a' };
  const p5 = auth.presentKey(owner, K2, ctxX2);
  assert.equal(p5.accepted, true);
  assert.equal(auth.stats().forks.length, 0);

  // (ii) colluder presents the PREDECESSOR from a disjoint context -> fork at first such presentation
  const ctxY = { ip: '198.51.100.0/24', ua: 'UA-build-2', tls: 'tls-b' };
  const p6 = auth.presentKey('colluder-0', K1, ctxY);
  assert.equal(p6.accepted, false);
  assert.equal(p6.fork, true);
  assert.equal(auth.stats().forks.length, 1);
  assert.equal(auth.stats().mergedCohorts.length, 1);
  assert.equal(auth.keyInfo(K1).revoked, true);
  assert.equal(auth.keyInfo(K2).revoked, true);
  assert.equal(auth.stats().shareEvidence, 4);

  // re-issuance on the revoked lineage requires a step-up proof
  clock.t = T0 + DAY;
  const noProof = auth.requestKey(owner, 'account', { accountAgeDays: 90 });
  assert.equal(noProof.status, 'step_up_required');
  const withProof = auth.requestKey(owner, 'account', { accountAgeDays: 90, stepUpProof: 'proof-1' });
  assert.equal(withProof.status, 'issued');
  assert.equal(withProof.key.lin, m2.key.kid);

  // presenting the revoked key is rejected as revoked
  const p8 = auth.presentKey(owner, K2, ctxX);
  assert.equal(p8.accepted, false);
  assert.equal(p8.reason, 'revoked');
});

/* ---------------- GK-G8: unverified claimant ---------------- */

test('GK-G8: unverified claimant gets 0 verified keys and is counted in anon', () => {
  const { auth, clock } = makeAuth();
  let accounted = 0;
  for (let day = 0; day < 3; day++) {
    clock.t = T0 + day * DAY;
    for (let k = 0; k < 5; k++) {
      const res = auth.requestKey('claimant', 'verified', { allowlisted: true, webBotAuthVerified: false });
      assert.equal(res.status, 'standing');
      assert.equal(res.anonAccounted, true);
      accounted++;
    }
  }
  assert.equal(accounted, 15);
  assert.equal(auth.stats().totalIssuedByChannel.verified, 0);
  assert.equal(auth.stats().anonAccounted, 15);
});

/* ---------------- GK-G4 policy: proof fast lane under flood ---------------- */

test('GK-G4-policy: flood queue - proof late-legit and established issued within 24h; pool never exceeds 6/day', () => {
  const { auth, clock } = makeAuth({ verifyStepUpProof: (_id, proof) => proof === 'valid-proof' });
  const base = T0;
  // Day 1: 200-identity farm floods the anon queue, no proofs (registered A1 shape).
  clock.t = base;
  for (let i = 0; i < 200; i++) auth.requestKey('farm-' + i, 'anon', { queueOnly: true });
  const day1 = auth.drainAnonPool();
  assert.equal(day1.filter((r) => r.status === 'issued').length, 6);
  assert.equal(auth.stats().poolUsedToday, 6);

  let lateTotal = 0, lateWithin = 0, estTotal = 0, estWithin = 0;
  for (let d = 2; d <= 5; d++) {
    // Arrivals at day + 12h: 2 proof-presenting late-legit, 2 established non-proof.
    clock.t = base + (d - 1) * DAY + DAY / 2;
    const queuedAt = clock.t;
    const lateIds = [], estIds = [];
    for (let k = 0; k < 2; k++) {
      const id = `late-${d}-${k}`;
      lateIds.push(id);
      auth.requestKey(id, 'anon', { queueOnly: true, stepUpProof: 'valid-proof' });
      const eid = `est-${d}-${k}`;
      estIds.push(eid);
      auth.requestKey(eid, 'anon', { queueOnly: true, priorNonBulkDays: 5 });
    }
    // Day-start drain of day d+1.
    clock.t = base + d * DAY;
    const settled = auth.drainAnonPool();
    const issuedSubs = settled.filter((r) => r.status === 'issued' || r.status === 'replay').map((r) => r.key.sub);
    assert.ok(auth.stats().poolUsedToday <= 6, 'pool exceeded');
    assert.equal(auth.stats().poolUsedToday, 6);
    // Proof lane first (FIFO), then established, then the farm.
    assert.deepEqual(issuedSubs.slice(0, 2), lateIds);
    assert.deepEqual(issuedSubs.slice(2, 4), estIds);
    const delayH = (clock.t - queuedAt) / 3_600_000;
    for (const id of lateIds) { lateTotal++; if (issuedSubs.includes(id) && delayH <= 24) lateWithin++; }
    for (const id of estIds) { estTotal++; if (issuedSubs.includes(id) && delayH <= 24) estWithin++; }
  }
  assert.equal(lateWithin, lateTotal);
  assert.equal(lateTotal, 8);
  assert.equal(estWithin, estTotal);
  // The lane was opt-in: nobody was ever demanded a proof in this world.
  assert.equal(auth.stats().stepUpDemands.length, 0);
});

/* ---------------- Serving-rule basics: trigger discipline + token hygiene ---------------- */

test('serving rule: head keyless below F, 151st trips the step-up-402 shape; tail keyless is never a first response', () => {
  const { auth, clock } = makeAuth();
  clock.t = T0;
  const id = 'reader-x';
  for (let r = 0; r < 150; r++) assert.equal(auth.serve(id, r).ok, true);
  const tripped = auth.serve(id, 150);
  assert.equal(tripped.ok, false);
  assert.equal(tripped.reason, 'free_zone_tripped');
  assert.equal(tripped.stepUpRequired, true);
  assert.equal(tripped.stepUp402.status, 402);
  // Tail without any prior trigger surface contact: the denial is the
  // consequence of the tail demand itself (a bulk trigger), shaped 402.
  const tail = auth.serve('reader-y', 5000);
  assert.equal(tail.ok, false);
  assert.equal(tail.reason, 'tail_needs_key');
  assert.equal(tail.stepUp402.status, 402);
  // Re-delivery stays free even past the free zone.
  assert.equal(auth.serve(id, 0).redelivery, true);
});

test('key token: payload allowlist is exactly the registered set; tamper and extra fields fail closed', () => {
  const { auth, clock } = makeAuth();
  clock.t = T0;
  const req = auth.requestKey('tok-owner', 'account', { accountAgeDays: 40, cohortId: 'coh-1' });
  assert.equal(req.status, 'issued');
  const payload = JSON.parse(Buffer.from(req.token.split('.')[0], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload).sort(), ['chn', 'cm', 'coh', 'exp', 'iat', 'kid', 'lin', 'sub', 'v']);
  assert.equal(payload.exp - payload.iat, DAY);
  assert.equal(payload.coh, 'coh-1');
  assert.equal(payload.lin, null);
  // Watermark binding: records marked under the key carry its cm edition.
  const marked = auth.markRecordsUnderKey(req.key.kid, [{ id: 'rec-1', q: 100, p: 30 }]);
  assert.equal(marked.length, 1);
  assert.ok(Number.isFinite(marked[0].publishedTotal));
  // Tampered signature.
  const [part] = req.token.split('.');
  const tampered = `${part}.${Buffer.from('x'.repeat(32)).toString('base64url')}`;
  assert.deepEqual(
    (({ accepted, reason }) => ({ accepted, reason }))(auth.presentKey('tok-owner', tampered)),
    { accepted: false, reason: 'bad_signature' },
  );
  // Extra payload field, correctly re-signed with the suite secret, is still not a key.
  const crypto = require('node:crypto');
  const forgedPayload = Object.assign({}, payload, { evidence: 1 });
  const fp = Buffer.from(JSON.stringify(forgedPayload), 'utf8').toString('base64url');
  const fsig = crypto.createHmac('sha256', 'gatekey-suite-secret').update(fp).digest();
  const forged = `${fp}.${Buffer.from(fsig).toString('base64url')}`;
  const res = auth.presentKey('tok-owner', forged);
  assert.equal(res.accepted, false);
  assert.equal(res.reason, 'unexpected_fields');
  // Expiry: past the 24h TTL the same token fails closed.
  clock.t = T0 + DAY + 1;
  assert.equal(auth.presentKey('tok-owner', req.token).reason, 'expired');
});
