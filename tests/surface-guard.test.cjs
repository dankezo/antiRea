"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createSurfaceGuard } = require("../dist/index.js");

const EHUST_RESPONSE = {
  student: {
    fullName: "Nguyen Van A",
    cpa: 3.21,
    gpa: 3.18,
    totalCredit: 120,
    classification: "Kha",
    password: "$2b$10$abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    password2: "$2b$10$abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    idNumber: "001202012345",
    idNumberDate: "2021-05-01",
    insuranceNumber: "HS4010123456789",
    phoneNumber: "0901234567",
    personalEmail: "a@example.com",
    avatarUrl: "https://example.com/a.jpg",
    cvUrl: "https://example.com/cv.pdf",
    homeAddress: "1 Dai Co Viet",
    bankAccount: "123456789012",
    bankName: "Techcombank",
  },
};

test("SG-G1: eHUST shape - sensitive fields caught on an undeclared route", () => {
  const guard = createSurfaceGuard();
  const r = guard.inspectResponse("GET /api/search/student", EHUST_RESPONSE);
  const fields = new Set(r.violations.map((v) => v.field));
  for (const f of ["password", "password2", "idNumber", "insuranceNumber", "bankAccount"]) {
    assert.ok(fields.has(f), `expected ${f} flagged, got ${[...fields].join(",")}`);
  }
  assert.ok(r.violations.every((v) => v.kind === "sensitive"));
});

test("declared fields are exempt from the denylist (login token is deliberate)", () => {
  const guard = createSurfaceGuard({
    routes: { "POST /login": { responseFields: ["token", "expiresAt", "user"] } },
  });
  const r = guard.inspectResponse("POST /login", { token: "abc", expiresAt: 1, user: { id: 7 } });
  // user.id is not in the allowlist by name ("id" undeclared) - but token must not appear
  assert.ok(!r.violations.some((v) => v.field === "token"));
});

test("schema layer flags undeclared fields with kind=undeclared", () => {
  const guard = createSurfaceGuard({
    routes: { "GET /profile": { responseFields: ["id", "name", "email"] } },
  });
  const r = guard.inspectResponse("GET /profile", { id: 1, name: "A", email: "e", ssn: "111" });
  const ssn = r.violations.find((v) => v.field === "ssn");
  assert.ok(ssn);
  assert.equal(ssn.kind, "sensitive"); // denylist kind wins over undeclared
  const r2 = guard.inspectResponse("GET /profile", { id: 1, name: "A", email: "e", nickname: "x" });
  assert.equal(r2.violations.length, 1);
  assert.equal(r2.violations[0].kind, "undeclared");
});

test("normalization: password_hash, passwordHash, Password-Hash are the same field", () => {
  const guard = createSurfaceGuard();
  for (const name of ["password_hash", "passwordHash", "Password-Hash", "PASSWORDHASH"]) {
    const r = guard.inspectResponse("GET /x", { [name]: "v" });
    assert.equal(r.violations.length, 1, name);
    assert.equal(r.violations[0].kind, "sensitive");
  }
});

test("request side: mass-assignment privileged fields caught", () => {
  const guard = createSurfaceGuard();
  const r = guard.inspectRequest("PATCH /users/7", { name: "New", role: "admin", is_superuser: true, owner_id: 1 });
  const fields = new Set(r.violations.map((v) => v.field));
  assert.ok(fields.has("role") && fields.has("is_superuser") && fields.has("owner_id"));
  assert.ok(r.violations.every((v) => v.kind === "privileged"));
});

test("advisory mode never touches the payload and ok stays true", () => {
  const guard = createSurfaceGuard();
  const payload = { password: "x" };
  const r = guard.inspectResponse("GET /x", payload);
  assert.equal(r.ok, true);
  assert.equal(r.sanitized, undefined);
  assert.deepEqual(payload, { password: "x" });
});

test("strip mode returns a sanitized copy without violating fields, original untouched", () => {
  const guard = createSurfaceGuard({ mode: "strip" });
  const payload = { user: { name: "A", bankAccount: "1" }, items: [{ id: 1, secret: "s" }] };
  const r = guard.inspectResponse("GET /x", payload);
  assert.deepEqual(r.sanitized, { user: { name: "A" }, items: [{ id: 1 }] });
  assert.equal(payload.user.bankAccount, "1");
});

test("block mode marks ok=false only when violations exist", () => {
  const guard = createSurfaceGuard({ mode: "block" });
  assert.equal(guard.inspectResponse("GET /x", { name: "A" }).ok, true);
  assert.equal(guard.inspectResponse("GET /x", { apiKey: "k" }).ok, false);
});

test("nested arrays: paths point at the offending element", () => {
  const guard = createSurfaceGuard();
  const r = guard.inspectResponse("GET /x", { students: [{ name: "a" }, { name: "b", cvv: "123" }] });
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].path, "students[1].cvv");
});

test("hostile payload: node cap truncates instead of scanning forever", () => {
  const guard = createSurfaceGuard({ maxScanNodes: 100 });
  const big = {};
  let cur = big;
  for (let i = 0; i < 5000; i++) {
    cur["f" + i] = i;
    cur.next = {};
    cur = cur.next;
  }
  const r = guard.inspectResponse("GET /x", big);
  assert.equal(r.truncated, true);
});

test("non-object payloads always pass", () => {
  const guard = createSurfaceGuard();
  for (const p of [null, undefined, 42, "password", true, [1, 2, 3]]) {
    const r = guard.inspectResponse("GET /x", p);
    assert.equal(r.violations.length, 0);
  }
});

test("onViolation fires with the event and a throwing handler is swallowed", () => {
  let seen = null;
  const guard = createSurfaceGuard({
    onViolation: (e) => {
      seen = e;
      throw new Error("operator bug");
    },
  });
  const r = guard.inspectResponse("GET /x", { secret: "s" });
  assert.equal(r.violations.length, 1);
  assert.ok(seen);
  assert.equal(seen.direction, "response");
});

test("custom extra patterns are honored", () => {
  const guard = createSurfaceGuard({ sensitivePatterns: ["internalnote"] });
  const r = guard.inspectResponse("GET /x", { internalNote: "n" });
  assert.equal(r.violations.length, 1);
});
