"use strict";
// RECOMB-10 declaration log - tests pin the chain semantics the
// lab measured (append-only entries, timestamp + hash chained to
// the previous entry, genesis prevHash = sha256 of the lab
// genesis seed): 200 appended entries verify intact, any tamper
// with an exported log makes import throw, predates reads the
// earliest timestamp, and an export/import roundtrip preserves
// every hash so the imported log can keep appending.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createDeclarationLog, importDeclarationLog } = require("../dist/index.js");

const GENESIS_PREV_HASH = crypto.createHash("sha256").update("RECOMB-10-GENESIS", "utf8").digest("hex");
const T0 = Date.UTC(2026, 10, 13, 0, 0, 0);
const DECLARATIONS = [
  { form: "robots-content-signal", declaration: "Content-Signal: search=yes, ai-input=no, ai-train=no" },
  { form: "rsl-license", declaration: "License: https://example.test/.well-known/rsl.json" },
  { form: "aipref-content-usage", declaration: "Content-Usage: ai-train=no, ai-use=no, search=yes" },
];

function filledLog(n) {
  const log = createDeclarationLog();
  for (let i = 0; i < n; i++) {
    const d = DECLARATIONS[i % DECLARATIONS.length];
    log.append({ form: d.form, declaration: d.declaration, timestamp: T0 + i * 1000 });
  }
  return log;
}

test("genesis entry chains to the fixed documented genesis constant", () => {
  const log = createDeclarationLog();
  const first = log.append({ form: "robots-content-signal", declaration: DECLARATIONS[0].declaration, timestamp: T0 });
  assert.equal(first.index, 0);
  assert.equal(first.prevHash, GENESIS_PREV_HASH);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
});

test("200 appended entries verify intact with the lab chain shape", () => {
  const log = filledLog(200);
  assert.deepEqual(log.verify(), { ok: true, checked: 200, firstBadIndex: null });
  const entries = log.entries();
  assert.equal(entries.length, 200);
  for (let i = 0; i < 200; i++) {
    assert.equal(entries[i].index, i);
    assert.equal(entries[i].timestamp, T0 + i * 1000);
    if (i > 0) assert.equal(entries[i].prevHash, entries[i - 1].hash);
  }
  assert.equal(entries[0].prevHash, GENESIS_PREV_HASH);
});

test("entries returns frozen copies that cannot rewrite the log", () => {
  const log = filledLog(3);
  const entries = log.entries();
  assert.ok(Object.isFrozen(entries));
  assert.ok(Object.isFrozen(entries[0]));
  assert.deepEqual(log.verify(), { ok: true, checked: 3, firstBadIndex: null });
});

test("tampering with one stored declaration in the export makes import throw", () => {
  const log = filledLog(200);
  const parsed = JSON.parse(log.export());
  parsed.entries[57].declaration = "Content-Signal: search=yes, ai-input=yes, ai-train=yes";
  assert.throws(() => importDeclarationLog(JSON.stringify(parsed)), /hash chain is broken at entry index 57/);
});

test("tampering with a stored hash or the order makes import throw", () => {
  const log = filledLog(10);
  const byHash = JSON.parse(log.export());
  byHash.entries[4].hash = "0".repeat(64);
  assert.throws(() => importDeclarationLog(JSON.stringify(byHash)), /DeclarationLogError|hash chain is broken/);
  const byOrder = JSON.parse(log.export());
  const tmp = byOrder.entries[2];
  byOrder.entries[2] = byOrder.entries[3];
  byOrder.entries[3] = tmp;
  assert.throws(() => importDeclarationLog(JSON.stringify(byOrder)));
  assert.throws(() => importDeclarationLog("not json"));
  assert.throws(() => importDeclarationLog("{}"));
  assert.throws(() => importDeclarationLog(42), TypeError);
});

test("predates reads the earliest entry timestamp", () => {
  const log = filledLog(200);
  assert.equal(log.predates(T0), true);
  assert.equal(log.predates(T0 - 1), false);
  assert.equal(log.predates(T0 + 199 * 1000), true);
  assert.equal(log.predates(T0 + 10_000_000), true);
  assert.equal(createDeclarationLog().predates(T0 + 10_000_000), false);
});

test("export/import roundtrip preserves every hash and keeps appending", () => {
  const log = filledLog(200);
  const before = log.entries();
  const restored = importDeclarationLog(log.export());
  assert.deepEqual(restored.verify(), { ok: true, checked: 200, firstBadIndex: null });
  assert.deepEqual(
    restored.entries().map((e) => ({ ...e })),
    before.map((e) => ({ ...e })),
  );
  const next = restored.append({ form: "robots-content-signal", declaration: DECLARATIONS[0].declaration, timestamp: T0 + 200 * 1000 });
  assert.equal(next.index, 200);
  assert.equal(next.prevHash, before[199].hash);
  assert.deepEqual(restored.verify(), { ok: true, checked: 201, firstBadIndex: null });
});

test("append rejects malformed input instead of corrupting the chain", () => {
  const log = createDeclarationLog();
  assert.throws(() => log.append({ form: "robots-content-signal", declaration: "x", timestamp: Number.NaN }), TypeError);
  assert.throws(() => log.append({ form: "robots-content-signal", declaration: "x", timestamp: Infinity }), TypeError);
  assert.throws(() => log.append({ form: "robots-content-signal", declaration: 42, timestamp: T0 }), TypeError);
  assert.throws(() => log.append({ form: null, declaration: "x", timestamp: T0 }), TypeError);
  assert.deepEqual(log.verify(), { ok: true, checked: 0, firstBadIndex: null });
});
