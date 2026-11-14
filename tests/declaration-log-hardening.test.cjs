"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createDeclarationLog, importDeclarationLog, DeclarationLogError, DECLARATION_LOG_GENESIS_SEED } = require("../dist/index.js");

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function input(timestamp = 100, declaration = "terms", form = "robots-content-signal") { return { timestamp, declaration, form }; }

test("declaration seeded append/import agrees with an independent hash chain", () => {
  assert.equal(DECLARATION_LOG_GENESIS_SEED, "RECOMB-10-GENESIS");
  for (let seed = 1; seed <= 30; seed++) {
    const random = rng(20291100 + seed);
    let log = createDeclarationLog();
    let previous = crypto.createHash("sha256").update("RECOMB-10-GENESIS").digest("hex");
    let earliest = Infinity;
    for (let i = 0; i < 40; i++) {
      const timestamp = Math.floor(random() * 2000000) - 1000000;
      const item = input(timestamp, "terms:" + seed + ":" + i, "form:" + i % 3);
      const expected = { index: i, timestamp, form: item.form, declaration: item.declaration, prevHash: previous };
      const hash = crypto.createHash("sha256").update(JSON.stringify(expected)).digest("hex");
      assert.deepEqual(log.append(item), { ...expected, hash });
      previous = hash;
      earliest = Math.min(earliest, timestamp);
      if (random() < 0.4) log = importDeclarationLog(log.export());
      assert.deepEqual(log.verify(), { ok: true, checked: i + 1, firstBadIndex: null });
      assert.equal(log.predates(earliest - 1), false);
      assert.equal(log.predates(earliest), true);
      assert.equal(log.predates(earliest + 1), true);
    }
    const original = JSON.parse(log.export());
    for (const field of ["index", "timestamp", "form", "declaration", "prevHash", "hash"]) {
      const changed = structuredClone(original);
      const e = changed.entries[Math.floor(random() * changed.entries.length)];
      e[field] = typeof e[field] === "number" ? e[field] + 1 : e[field] + "x";
      assert.throws(() => importDeclarationLog(JSON.stringify(changed)), DeclarationLogError);
    }
  }
});

test("declaration import validates format, version, shape and every chain leg", () => {
  const log = createDeclarationLog(); log.append(input()); log.append(input(200));
  const original = JSON.parse(log.export());
  for (const change of [{ format: "other" }, { version: 2 }, { version: "1" }, { format: undefined }, { entries: {} }, { entries: null }]) {
    assert.throws(() => importDeclarationLog(JSON.stringify({ ...original, ...change })), DeclarationLogError);
  }
  for (const value of ["null", "[]", "42", "true", "", "{"]) assert.throws(() => importDeclarationLog(value), DeclarationLogError);
  for (const value of [null, undefined, 1, {}]) assert.throws(() => importDeclarationLog(value), TypeError);
  for (const field of ["index", "timestamp", "form", "declaration", "prevHash", "hash"]) {
    const item = structuredClone(original); item.entries[0][field] = null;
    assert.throws(() => importDeclarationLog(JSON.stringify(item)), DeclarationLogError);
  }
  const duplicate = structuredClone(original); duplicate.entries[1] = duplicate.entries[0];
  assert.throws(() => importDeclarationLog(JSON.stringify(duplicate)), DeclarationLogError);
});

test("declaration capacity boundaries refuse append atomically and preserve history", () => {
  const options = { maxEntries: 2, maxDeclarationLength: 5, maxFormLength: 3 };
  const log = createDeclarationLog(options);
  log.append(input(1, "12345", "abc"));
  for (const item of [input(2, "123456", "abc"), input(2, "12345", "abcd")]) assert.throws(() => log.append(item), DeclarationLogError);
  assert.equal(log.entries().length, 1);
  log.append(input(2, "x", "a"));
  assert.throws(() => log.append(input(3, "x", "a")), DeclarationLogError);
  assert.equal(log.entries().length, 2);
  assert.equal(log.verify().ok, true);
  assert.throws(() => importDeclarationLog(log.export(), { maxEntries: 1 }), DeclarationLogError);
  assert.throws(() => importDeclarationLog(log.export(), { maxDeclarationLength: 4 }), DeclarationLogError);
  assert.throws(() => importDeclarationLog(log.export(), { maxFormLength: 2 }), DeclarationLogError);
  assert.equal(importDeclarationLog(log.export(), options).entries().length, 2);
});

test("declaration serialized size is a roundtrip-safe exact boundary", () => {
  const source = createDeclarationLog(); source.append(input(1));
  const size = source.export().length;
  const exact = createDeclarationLog({ maxSerializedLength: size });
  exact.append(input(1)); assert.equal(exact.export().length, size);
  assert.equal(importDeclarationLog(exact.export(), { maxSerializedLength: size }).verify().ok, true);
  assert.throws(() => exact.append(input(2)), DeclarationLogError);
  const small = createDeclarationLog({ maxSerializedLength: size - 1 });
  assert.throws(() => small.append(input(1)), DeclarationLogError);
  assert.equal(small.entries().length, 0);
  assert.throws(() => importDeclarationLog(source.export(), { maxSerializedLength: size - 1 }), DeclarationLogError);
  assert.throws(() => createDeclarationLog({ maxSerializedLength: 1 }), DeclarationLogError);
});

test("declaration options and hostile input reject before mutating state", () => {
  for (const key of ["maxEntries", "maxDeclarationLength", "maxFormLength", "maxSerializedLength"]) {
    for (const value of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, "3", null]) assert.throws(() => createDeclarationLog({ [key]: value }), TypeError);
  }
  for (const value of [null, [], 3]) assert.throws(() => createDeclarationLog(value), TypeError);
  const log = createDeclarationLog();
  for (const value of [null, undefined, 1, input(NaN), input(Infinity), input(-Infinity), { ...input(), form: 1 }, { ...input(), declaration: 1 }]) assert.throws(() => log.append(value), TypeError);
  assert.equal(log.verify().checked, 0);
  assert.equal(log.predates(0), false);
  log.append(input(-1, "__proto__", "__proto__"));
  for (const value of [NaN, Infinity, -Infinity, "100", null]) assert.equal(log.predates(value), false);
  const entries = log.entries(); assert.ok(Object.isFrozen(entries)); assert.ok(Object.isFrozen(entries[0]));
  assert.throws(() => { entries[0].declaration = "mutated"; }, TypeError);
  assert.equal(log.entries()[0].declaration, "__proto__");
  assert.equal(Object.prototype.polluted, undefined);
});
