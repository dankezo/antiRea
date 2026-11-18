"use strict";
// LCP-08 - any external lookup budget needs per-identity fairness
// and a non-cacheable degraded mode.
//
// Lab record (port-measured logic verdict, no PHP runtime was
// available; RESULTS-LCP-STEP0.md, cycle C578): in the dissected
// third-party CAPTCHA library a third-party abuse-lookup budget was
// a single global daily pool - a flood of 1,000 unique IPs made
// exactly 1,000 API calls and exhausted it, IP 1001 then scored 0
// with zero additional calls, and that degraded 0 was cached per IP
// for 6 h (21,600 s), so one flood degraded strangers for hours.
//
// antiRea form of the rule: the SDK is zero-dependency and performs
// NO external lookups itself (pinned by the source audit in this
// file), so there is no SDK budget to exhaust. The lookup-adjacent
// surface it does ship - host-fed verification-fact classification
// (verification-fact.ts) - is built to the rule's shape, and this
// file pins that shape:
// - classification is a pure function of the fact the host feeds
//   it: there is no cache anywhere in the surface, so a degraded
//   outcome cannot stick to an identity (no 6 h cached 0);
// - there is no shared pool: 1,000 degraded outcomes for other
//   identities change nothing about the next identity's genuine
//   outcome (per-identity fairness by construction);
// - the degraded outcome itself is neutral (unverified, evidence
//   delta 0), never a negative verdict against the identity.
// Hosts that wire their own budgeted third-party lookup into
// antiRea must keep the same shape; the rule is also recorded in
// docs/LIMITATIONS.md.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const sdk = require("../dist/index.js");

test("source audit: no shipped module performs a network lookup (zero external budget exists in the SDK)", () => {
  const srcRoot = join(__dirname, "..", "src");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".ts")) files.push(join(dir, entry.name));
    }
  };
  walk(srcRoot);
  assert.ok(files.length > 50, "audit must cover the shipped source tree, saw " + files.length + " files");
  const egress = /\bfetch\s*\(|XMLHttpRequest|node:https?|node:dns|node:net|\bdns\.(lookup|resolve)|\bnet\.connect|https?\.(request|get)\s*\(/;
  const offenders = files.filter((f) => egress.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders, [], "modules performing network egress: " + offenders.join(", "));
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined, "runtime dependencies must stay absent (zero-dependency)");
});

test("flood analogue: 1,000 degraded outcomes for other identities do not degrade identity 1001", () => {
  // The lab flood shape, replayed against the classification
  // surface: 1,000 unique identities whose lookups all fail.
  for (let i = 1; i <= 1000; i++) {
    const fact = sdk.classifyHostVerificationFact("fcrdns", "lookup failure");
    assert.equal(fact.state, "unverified");
    assert.equal(fact.evidenceDelta, 0);
  }
  // Identity 1001 arrives with a genuine verified fact. In the lab
  // it scored a cached 0 with zero calls; here nothing was spent
  // and nothing was cached, so the genuine fact classifies fully.
  const genuine = sdk.classifyHostVerificationFact("fcrdns", "forward-confirmed match");
  assert.equal(genuine.state, "verified");
  assert.equal(genuine.evidenceDelta, 0); // BS-01: verified is neutral, never a bonus
});

test("the degraded mode is non-cacheable: a lookup failure never sticks to the identity", () => {
  // Degraded now...
  const degraded1 = sdk.classifyHostVerificationFact("fcrdns", "lookup failure");
  const degraded2 = sdk.classifyHostVerificationFact("fcrdns", "lookup failure");
  assert.deepEqual(degraded1, degraded2, "classification is pure: same fact in, same fact out, no state");
  // ...and the moment the host's lookup recovers, the very next
  // classification for the same identity is the genuine one. There
  // is no per-IP cache entry to live out a 6 h TTL.
  const recovered = sdk.classifyHostVerificationFact("fcrdns", "forward-confirmed match");
  assert.equal(recovered.state, "verified");
  // The range surface has the same shape: stale list degrades to
  // unverified, a fresh list classifies, nothing sticks.
  assert.equal(sdk.classifyHostVerificationFact("range", "list unavailable or stale").state, "unverified");
  assert.equal(sdk.classifyHostVerificationFact("range", "inside published range").state, "verified");
  assert.equal(sdk.classifyHostVerificationFact("range", "list unavailable or stale").state, "unverified");
});

test("degraded outcomes are neutral, never evidence against the identity", () => {
  for (const [source, outcome] of [
    ["fcrdns", "lookup failure"],
    ["fcrdns", "some future outcome string"],
    ["range", "list unavailable or stale"],
    ["range", "outside published range"],
  ]) {
    const fact = sdk.classifyHostVerificationFact(source, outcome);
    assert.equal(fact.state, "unverified", source + " / " + outcome);
    assert.equal(fact.evidenceDelta, 0, "a degraded lookup must not become negative evidence");
  }
});
