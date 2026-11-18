"use strict";
// ABE-03 identity-rotation signal - tests mirror the frozen lab strata
// of abe-lab/REGISTRATION-ABE-STEP0.md (seed 20321103) at SDK scale:
// rotation on both axes must flag 200/200, every legit control 0/200.
// Lab sessions are 20 requests at t = 0,3,...,57 s; here ts is in ms
// and each session uses its own fingerprint (as the lab JA4 suffix did),
// except CGNAT where one IP carries 20 distinct fingerprints.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createIdentityRotationSignal } = require("../dist/index.js");

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20321103);
function hex(n) {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(rng() * 16)];
  return s;
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
function fpA() { return `t13d1517h2_8daaf615_${hex(6)}|${UA}|203.0.113.0/24`; }

const ROT_IPS = ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5", "203.0.113.6", "203.0.113.7"];
const ROT_KEYS = ["k1", "k2", "k3", "k4", "k5", "k6", "k7"];
const N = 200;

function runSessions(build) {
  let flagged = 0;
  for (let s = 0; s < N; s++) {
    const sig = createIdentityRotationSignal();
    const fp = build.fingerprint ? build.fingerprint(s) : fpA();
    let last;
    for (let i = 0; i < 20; i++) {
      const ev = build.event(i, fp, s);
      last = sig.observe({ fingerprint: ev.fingerprint ?? fp, declaredIp: ev.ip, declaredApiKey: ev.key, ts: i * 3000 });
    }
    if (last.assessment.flagged) flagged++;
  }
  return flagged;
}

test("ROT-IP: 7 IPs rotating every 3rd request flags 200/200", () => {
  const flagged = runSessions({
    event: (i) => ({ ip: ROT_IPS[Math.floor(i / 3) % 7], key: "k-fixed" }),
  });
  assert.equal(flagged, 200);
});

test("ROT-KEY: 7 keys rotating every 3rd request flags 200/200", () => {
  const flagged = runSessions({
    event: (i) => ({ ip: "203.0.113.50", key: ROT_KEYS[Math.floor(i / 3) % 7] }),
  });
  assert.equal(flagged, 200);
});

test("LEGIT-MOBILE: one IP change mid-session flags 0/200", () => {
  const flagged = runSessions({
    event: (i) => ({ ip: i < 11 ? "203.0.113.9" : "198.51.100.77", key: "k-fixed" }),
  });
  assert.equal(flagged, 0);
});

test("LEGIT-CGNAT: one IP with 20 distinct fingerprints flags 0/200", () => {
  let flagged = 0;
  for (let s = 0; s < N; s++) {
    const sig = createIdentityRotationSignal();
    let any = false;
    for (let i = 0; i < 20; i++) {
      const fp = `t13d1517h2_8daaf615_${hex(6)}|${UA}|198.51.100.0/24`;
      const r = sig.observe({ fingerprint: fp, declaredIp: "198.51.100.1", declaredApiKey: "k-fixed", ts: i * 3000 });
      if (r.assessment.flagged) any = true;
    }
    if (any || sig.evaluate().flagged.length > 0) flagged++;
  }
  assert.equal(flagged, 0);
});

test("LEGIT-KEYROT: one scheduled key change flags 0/200", () => {
  const flagged = runSessions({
    event: (i) => ({ ip: "203.0.113.60", key: i < 11 ? "k-old" : "k-new" }),
  });
  assert.equal(flagged, 0);
});

test("SINGLE-CHANGE: one IP change flags 0/200", () => {
  const flagged = runSessions({
    event: (i) => ({ ip: i < 11 ? "203.0.113.9" : "203.0.113.10", key: "k-fixed" }),
  });
  assert.equal(flagged, 0);
});

test("threshold is exactly 3: two distinct values never flag, third flags on the right axis", () => {
  const sig = createIdentityRotationSignal();
  const fp = "fp-threshold";
  sig.observe({ fingerprint: fp, declaredIp: "10.0.0.1", declaredApiKey: "a", ts: 0 });
  sig.observe({ fingerprint: fp, declaredIp: "10.0.0.2", declaredApiKey: "a", ts: 1000 });
  let a = sig.check(fp, 1000);
  assert.equal(a.flagged, false);
  assert.equal(a.distinctIps, 2);
  const r = sig.observe({ fingerprint: fp, declaredIp: "10.0.0.3", declaredApiKey: "a", ts: 2000 });
  assert.equal(r.assessment.flagged, true);
  assert.equal(r.assessment.axis, "ip");
  assert.equal(r.assessment.distinctApiKeys, 1);
});

test("window expiry: rotation spread beyond 60 s does not accumulate", () => {
  const sig = createIdentityRotationSignal();
  const fp = "fp-window";
  sig.observe({ fingerprint: fp, declaredIp: "10.0.0.1", ts: 0 });
  sig.observe({ fingerprint: fp, declaredIp: "10.0.0.2", ts: 61000 });
  const r = sig.observe({ fingerprint: fp, declaredIp: "10.0.0.3", ts: 122000 });
  assert.equal(r.assessment.flagged, false);
  assert.equal(r.assessment.distinctIps, 1);
});

test("evaluate lists flagged fingerprints sorted, enforcement none everywhere", () => {
  const sig = createIdentityRotationSignal();
  for (const fp of ["fp-b", "fp-a"]) {
    for (let i = 0; i < 3; i++) sig.observe({ fingerprint: fp, declaredIp: "10.0.1." + i, ts: i * 1000 });
  }
  sig.observe({ fingerprint: "fp-quiet", declaredIp: "10.0.9.1", ts: 0 });
  const res = sig.evaluate();
  assert.equal(res.kind, "identity-rotation");
  assert.equal(res.enforcement, "none");
  assert.deepEqual(res.flagged.map((f) => f.fingerprint), ["fp-a", "fp-b"]);
  assert.equal(res.trackedFingerprints, 3);
  assert.equal(sig.snapshot().enforcement, "none");
});

test("invalid timestamps are refused without touching state; bad keys throw", () => {
  const sig = createIdentityRotationSignal();
  const r = sig.observe({ fingerprint: "fp-x", declaredIp: "10.0.0.1", ts: NaN });
  assert.equal(r.status, "invalid_ts");
  assert.equal(r.counted, false);
  assert.equal(sig.snapshot().counters.invalidTs, 1);
  assert.equal(sig.snapshot().fingerprints, 0);
  assert.throws(() => sig.observe({ fingerprint: "", ts: 0 }), /fingerprint/);
  assert.throws(() => createIdentityRotationSignal({ rotateThreshold: 1 }), /rotateThreshold/);
});
