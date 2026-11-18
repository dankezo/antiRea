"use strict";
// ABE-02 prefix-trap corroboration layer - tests encode the measured
// lab cells of abe-lab/RESULTS-ABE-STEP0.md (abe02.cjs, seed 20321102).
// This layer never matches paths: every recordHit call below stands
// for a hit the caller's matcher already decided (the NHS-12 prefix
// form). What is asserted here is the corroboration semantics: a
// single hit is uncorroborated taint with consequenceEligible false,
// exclusions need both of their halves, and only a repeat hit or an
// independent signal corroborates.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createTrapCorroborationTracker,
  isVerifiedCrawlerTrapExempt,
  isInternalHealthTrapExempt,
} = require("../dist/index.js");

const GOOGLEBOT_UA = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BINGBOT_UA = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
const CHROME_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const TRAP_PATHS = ["/admin/", "/.env", "/wp-admin/", "/api/debug/health", "/api/v1/internal/config"];
const BASE = 1_700_000_000_000;

test("TYPO descriptive cell: single-hit typo taint is 5/5 uncorroborated, 0/5 eligible", () => {
  const tracker = createTrapCorroborationTracker();
  let tainted = 0, eligible = 0;
  for (let i = 0; i < 5; i++) {
    const s = tracker.recordHit({
      identity: "typo-" + i, path: "/.env", ts: BASE + i * 1000,
      userAgent: CHROME_UA, ip: "203.0.113.44",
    });
    if (s.taint !== "none") tainted++;
    if (s.consequenceEligible) eligible++;
    assert.equal(s.taint, "uncorroborated");
    assert.equal(s.hits, 1);
    assert.equal(s.enforcement, "none");
  }
  assert.equal(tainted, 5);
  assert.equal(eligible, 0);
});

test("CRAWLER-SPOOF descriptive cell: spoofed rDNS taints 10/10 (UA alone never exempts)", () => {
  const tracker = createTrapCorroborationTracker();
  let tainted = 0;
  for (let i = 0; i < 10; i++) {
    const s = tracker.recordHit({
      identity: "spoof-" + i, path: TRAP_PATHS[i % TRAP_PATHS.length], ts: BASE + i * 1000,
      userAgent: GOOGLEBOT_UA, rdns: "evil.example.com", ip: "203.0.113.99",
    });
    if (s.taint !== "none") tainted++;
    assert.equal(s.excludedHits, 0);
  }
  assert.equal(tainted, 10);
  assert.equal(isVerifiedCrawlerTrapExempt(GOOGLEBOT_UA, "evil.example.com"), false);
  assert.equal(isVerifiedCrawlerTrapExempt(GOOGLEBOT_UA, undefined), false);
});

test("TRAP-CRAWLER gate cell: verified crawlers count 0/20 taint", () => {
  const tracker = createTrapCorroborationTracker();
  let tainted = 0;
  for (let i = 0; i < 10; i++) {
    const s = tracker.recordHit({
      identity: "crawler-g-" + i, path: TRAP_PATHS[i % TRAP_PATHS.length], ts: BASE + i * 1000,
      userAgent: GOOGLEBOT_UA, rdns: "crawl-66-249-66-1.googlebot.com", ip: "66.249.66.1",
    });
    if (s.taint !== "none") tainted++;
  }
  for (let i = 0; i < 10; i++) {
    const s = tracker.recordHit({
      identity: "crawler-b-" + i, path: TRAP_PATHS[i % TRAP_PATHS.length], ts: BASE + i * 1000,
      userAgent: BINGBOT_UA, rdns: "msnbot-131-253-24-1.search.msn.com", ip: "131.253.24.1",
    });
    if (s.taint !== "none") tainted++;
  }
  assert.equal(tainted, 0);
  assert.equal(tracker.snapshot().counters.excludedHits, 20);
  assert.equal(tracker.snapshot().counters.hits, 0);
});

test("TRAP-HEALTH gate cell: internal health checks count 0/20 taint; external probe UA taints 10/10", () => {
  const tracker = createTrapCorroborationTracker();
  let internalTainted = 0;
  for (let i = 0; i < 20; i++) {
    const s = tracker.recordHit({
      identity: "health-" + i, path: "/api/debug/health", ts: BASE + i * 1000,
      userAgent: "kube-probe/1.0", ip: "10.1.2.3",
    });
    if (s.taint !== "none") internalTainted++;
  }
  assert.equal(internalTainted, 0);
  let externalTainted = 0;
  for (let i = 0; i < 10; i++) {
    const s = tracker.recordHit({
      identity: "health-ext-" + i, path: "/api/debug/health", ts: BASE + i * 1000,
      userAgent: "kube-probe/1.0", ip: "203.0.113.9",
    });
    if (s.taint !== "none") externalTainted++;
  }
  assert.equal(externalTainted, 10);
  assert.equal(isInternalHealthTrapExempt("203.0.113.9", "kube-probe/1.0"), false);
  assert.equal(isInternalHealthTrapExempt("10.1.2.3", CHROME_UA), false);
});

test("env-variant over-breadth: hits on all 5 env-variant paths are still only uncorroborated taint", () => {
  // The 5 paths are the lab's G11 cell: the /.env prefix hits every
  // one of them. Each is fed here as a matcher-decided hit from its
  // own identity, so the over-broad surface produces taint 5/5 and
  // eligibility 0/5 - breadth alone corroborates nothing.
  const tracker = createTrapCorroborationTracker();
  const variants = ["/.env.example", "/.envrc", "/.env.local", "/.env.bak", "/.env.sample"];
  let tainted = 0, eligible = 0;
  variants.forEach((path, i) => {
    const s = tracker.recordHit({
      identity: "env-" + i, path, ts: BASE + i * 1000, userAgent: CHROME_UA, ip: "203.0.113.7",
    });
    if (s.taint !== "none") tainted++;
    if (s.consequenceEligible) eligible++;
  });
  assert.equal(tainted, 5);
  assert.equal(eligible, 0);
});

test("corroboration by repeat: a second hit inside the window corroborates", () => {
  const tracker = createTrapCorroborationTracker();
  const first = tracker.recordHit({ identity: "scanner", path: "/.env", ts: BASE, userAgent: CHROME_UA, ip: "203.0.113.5" });
  assert.equal(first.taint, "uncorroborated");
  assert.equal(first.consequenceEligible, false);
  const second = tracker.recordHit({ identity: "scanner", path: "/wp-admin/", ts: BASE + 5000, userAgent: CHROME_UA, ip: "203.0.113.5" });
  assert.equal(second.taint, "corroborated");
  assert.equal(second.consequenceEligible, true);
  assert.equal(second.hits, 2);
});

test("corroboration by independent signal: noteIndependentSignal corroborates existing taint", () => {
  const tracker = createTrapCorroborationTracker();
  tracker.recordHit({ identity: "suspect", path: "/admin/", ts: BASE, userAgent: CHROME_UA, ip: "203.0.113.6" });
  assert.equal(tracker.check("suspect", BASE).taint, "uncorroborated");
  const s = tracker.noteIndependentSignal("suspect", BASE + 1000);
  assert.equal(s.taint, "corroborated");
  assert.equal(s.consequenceEligible, true);
  // A signal with no hit corroborates nothing: taint stays none.
  const empty = tracker.noteIndependentSignal("clean", BASE + 1000);
  assert.equal(empty.taint, "none");
  assert.equal(empty.consequenceEligible, false);
});

test("corroboration carried on the hit itself: independentSignalFired corroborates a first hit", () => {
  const tracker = createTrapCorroborationTracker();
  const s = tracker.recordHit({
    identity: "combo", path: "/api/debug/env", ts: BASE,
    userAgent: CHROME_UA, ip: "203.0.113.8", independentSignalFired: true,
  });
  assert.equal(s.taint, "corroborated");
  assert.equal(s.consequenceEligible, true);
});

test("window expiry: a repeat hit after the window does not corroborate the stale hit", () => {
  const tracker = createTrapCorroborationTracker({ windowMs: 60000 });
  tracker.recordHit({ identity: "slow", path: "/.env", ts: BASE, userAgent: CHROME_UA, ip: "203.0.113.9" });
  const s = tracker.recordHit({ identity: "slow", path: "/.env.bak", ts: BASE + 61000, userAgent: CHROME_UA, ip: "203.0.113.9" });
  assert.equal(s.hits, 1);
  assert.equal(s.taint, "uncorroborated");
  assert.equal(s.consequenceEligible, false);
});

test("excluded hits never corroborate: verified crawler hits after a real hit add nothing", () => {
  const tracker = createTrapCorroborationTracker();
  tracker.recordHit({ identity: "mix", path: "/.env", ts: BASE, userAgent: CHROME_UA, ip: "203.0.113.10" });
  const s = tracker.recordHit({
    identity: "mix", path: "/admin/", ts: BASE + 1000,
    userAgent: GOOGLEBOT_UA, rdns: "crawl-66-249-66-1.googlebot.com", ip: "66.249.66.1",
  });
  assert.equal(s.hits, 1);
  assert.equal(s.excludedHits, 1);
  assert.equal(s.taint, "uncorroborated");
});
