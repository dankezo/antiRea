/**
 * U2 - Per-session polymorphic challenge payload (antiRea 3.3.2,
 * DEC-1 client component, scoped to U2 ONLY).
 *
 * FROZEN HONEST FRAMING - never exceed this anywhere: U2 is an
 * EXECUTION TAX, not a wall. A real agent that executes JavaScript
 * still passes. This module does not block bots or agents; it makes
 * each step-up cost one fresh, per-session execution whose result
 * cannot be reused for another session, another challenge, or a
 * replay. The measured basis for the shape is research file J4:
 * static obfuscation loses to an executing agent, so the payload
 * rotates per session (fast rotation), is useless without the
 * server seed (incomplete without the server), and is minted fresh
 * per session (many distinct copies) - the three conditions under
 * which code noise was shown to cost anything at all.
 *
 * WHAT IT DOES. `issue(sessionId)` mints a single-use challenge:
 * a small JavaScript payload generated from a seeded PRNG derived
 * from HMAC(secret, sessionId + challengeId). The payload is a
 * multi-step computation over a session value baked in at issue
 * time, morphed per challenge:
 *   (a) every identifier - the entry function and every variable -
 *       is drawn fresh from the seed, so no identifier is shared
 *       across sessions;
 *   (b) the step order is a randomized topological order of the
 *       step graph: dependencies are respected only through
 *       explicit value threading (each step names the variables
 *       it reads), never through source position alone;
 *   (c) decoy dead steps are interleaved in the same order shuffle:
 *       they compute values into variables nothing ever reads, and
 *       their results are discarded.
 * Executing the payload exposes one function (its name is the
 * `entryName` in the issuance) that returns the answer string.
 *
 * VERIFICATION NEVER EXECUTES THE PAYLOAD. The verifier re-derives
 * the same plan from the same seed server-side, recomputes the
 * expected answer arithmetically, and compares in constant time.
 * Challenges expire (`ttlMs`, injectable clock) and are SINGLE
 * USE: the first verification attempt against a live challenge -
 * passing or failing - consumes it, so neither a consumed nor a
 * failed challenge can be replayed or probed twice.
 *
 * OPT-IN, SERVER SIDE. The secret never leaves the server; only
 * the generated payload does. State is per-instance (the
 * outstanding-challenge map below); there is no global state.
 * Pair with the DEC-1 client component
 * (src/client/u2-challenge-client.ts) on the host page.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring pow-hashcash).         */
/* ------------------------------------------------------------------------ */

interface NodeHmacLike {
  update(data: unknown, encoding?: string): NodeHmacLike;
  digest(encoding: string): string;
}
interface NodeCryptoLike {
  createHmac(algorithm: string, key: string): NodeHmacLike;
  randomBytes(size: number): Uint8Array;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}
declare const require: ((id: string) => NodeCryptoLike) | undefined;
function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; polymorphic challenges require Node.js");
}

/* ------------------------------------------------------------------------ */
/* Seeded PRNG (mulberry32 over an HMAC-derived 32-bit seed).               */
/* ------------------------------------------------------------------------ */

function deriveSeedHex(secret: string, sessionId: string, challengeId: string): string {
  return getNodeCrypto()
    .createHmac("sha256", secret)
    .update(`u2\0${sessionId}\0${challengeId}`, "utf8")
    .digest("hex");
}

function prngFromSeedHex(seedHex: string): () => number {
  let a = parseInt(seedHex.slice(0, 8), 16) | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------------ */
/* Plan generation: the one source of truth for payload AND expected        */
/* answer. Verification calls this and reads `answer`; it never runs the    */
/* generated source.                                                        */
/* ------------------------------------------------------------------------ */

const MOD = 1000003;
const REAL_STEPS = 6;
const DEAD_STEPS = 3;
const IDENT_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const IDENT_TAIL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

interface PlanStep {
  name: string;
  /** Variable names this step reads (explicit value threading). */
  deps: string[];
  /** JS expression producing this step's value. */
  expr: string;
  /** Server-side computed value of this step. */
  value: number;
  dead: boolean;
}

interface ChallengePlan {
  entryName: string;
  payload: string;
  answer: string;
  /** Names of the decoy dead-step variables (server-side record). */
  deadNames: string[];
}

function generatePlan(secret: string, sessionId: string, challengeId: string): ChallengePlan {
  const rnd = prngFromSeedHex(deriveSeedHex(secret, sessionId, challengeId));
  const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)] as T;

  const usedNames = new Set<string>();
  const freshName = (): string => {
    for (;;) {
      let name = "_" + (IDENT_ALPHABET[Math.floor(rnd() * IDENT_ALPHABET.length)] as string);
      const tailLen = int(5, 9);
      for (let i = 0; i < tailLen; i++) name += IDENT_TAIL[Math.floor(rnd() * IDENT_TAIL.length)];
      if (!usedNames.has(name)) {
        usedNames.add(name);
        return name;
      }
    }
  };

  const entryName = freshName();
  const rootName = freshName();
  const rootValue = int(1009, 98999);

  const valueOf = new Map<string, number>([[rootName, rootValue]]);
  const makeStep = (available: string[], dead: boolean): PlanStep => {
    const name = freshName();
    const aName = pick(available);
    const a = valueOf.get(aName) as number;
    const kind = available.length >= 2 ? int(0, 5) : int(0, 2);
    let deps: string[];
    let expr: string;
    let value: number;
    if (kind === 3 || kind === 4) {
      const others = available.filter((n) => n !== aName);
      const bName = pick(others);
      const b = valueOf.get(bName) as number;
      deps = [aName, bName];
      if (kind === 3) {
        expr = `(${aName} + ${bName}) % ${MOD}`;
        value = (a + b) % MOD;
      } else {
        expr = `(${aName} * 31 + ${bName}) % ${MOD}`;
        value = (a * 31 + b) % MOD;
      }
    } else if (kind === 0) {
      const k = int(3, 997);
      deps = [aName];
      expr = `(${aName} + ${k}) % ${MOD}`;
      value = (a + k) % MOD;
    } else if (kind === 1) {
      const k = int(2, 17);
      deps = [aName];
      expr = `(${aName} * ${k}) % ${MOD}`;
      value = (a * k) % MOD;
    } else if (kind === 2) {
      const k = int(17, 4095);
      deps = [aName];
      expr = `(${aName} ^ ${k}) % ${MOD}`;
      value = (a ^ k) % MOD;
    } else {
      const k = int(3, 997);
      deps = [aName];
      expr = `((${aName} - ${k}) % ${MOD} + ${MOD}) % ${MOD}`;
      value = (((a - k) % MOD) + MOD) % MOD;
    }
    valueOf.set(name, value);
    return { name, deps, expr, value, dead };
  };

  // Real steps: each may read the root or any earlier real step.
  const realSteps: PlanStep[] = [];
  const realNames: string[] = [rootName];
  for (let i = 0; i < REAL_STEPS; i++) {
    const step = makeStep(realNames, false);
    realSteps.push(step);
    realNames.push(step.name);
  }
  // Final combine: a real step over two distinct earlier real values,
  // so the answer threads several branches, not just the last step.
  const finalStep = ((): PlanStep => {
    const name = freshName();
    const pool = realNames.slice(1);
    const aName = pick(pool);
    const others = pool.filter((n) => n !== aName);
    const bName = pick(others);
    const a = valueOf.get(aName) as number;
    const b = valueOf.get(bName) as number;
    const value = (a * 31 + b) % MOD;
    valueOf.set(name, value);
    return { name, deps: [aName, bName], expr: `(${aName} * 31 + ${bName}) % ${MOD}`, value, dead: false };
  })();

  // Decoy dead steps: read the root or real values, write variables
  // nothing ever reads. They never enter `realNames`, so no real
  // step (or the final combine) can depend on them.
  const deadSteps: PlanStep[] = [];
  for (let i = 0; i < DEAD_STEPS; i++) deadSteps.push(makeStep(realNames, true));

  // Randomized topological order (Kahn with PRNG tie-breaking):
  // a step is emitted only after every variable it reads exists.
  const all: PlanStep[] = [...realSteps, finalStep, ...deadSteps];
  const emitted = new Set<string>([rootName]);
  const ordered: PlanStep[] = [];
  const pending = [...all];
  while (pending.length > 0) {
    const readyIdx: number[] = [];
    pending.forEach((s, idx) => {
      if (s.deps.every((d) => emitted.has(d))) readyIdx.push(idx);
    });
    if (readyIdx.length === 0) throw new Error("polymorphic challenge: step graph has a cycle");
    const chosen = readyIdx[Math.floor(rnd() * readyIdx.length)] as number;
    const [step] = pending.splice(chosen, 1) as [PlanStep];
    ordered.push(step);
    emitted.add(step.name);
  }

  const lines: string[] = [`var ${rootName} = ${rootValue};`];
  for (const step of ordered) lines.push(`var ${step.name} = ${step.expr};`);
  lines.push(`return String(${finalStep.name});`);
  const payload = `var ${entryName} = function () {\n${lines.map((l) => `  ${l}`).join("\n")}\n};`;

  return { entryName, payload, answer: String(finalStep.value), deadNames: deadSteps.map((s) => s.name) };
}

/* ------------------------------------------------------------------------ */
/* Issuer / verifier.                                                       */
/* ------------------------------------------------------------------------ */

export const U2_DEFAULT_TTL_MS = 120_000;

export interface PolymorphicChallengeOptions {
  /** HMAC secret (host-side only, never shipped to clients). */
  secret: string;
  /** Challenge lifetime in milliseconds. Default 120,000 (2 minutes). */
  ttlMs?: number;
  /** Injectable clock, ms since epoch. Default Date.now. */
  now?: () => number;
  /** Cap on outstanding (unconsumed) challenges. Default 10,000. */
  maxOutstanding?: number;
}

export interface IssuedPolymorphicChallenge {
  challengeId: string;
  /** JavaScript source for the client component to execute. */
  payload: string;
  /** Name of the payload's entry function (rotated per challenge). */
  entryName: string;
  /** Expiry, ms since epoch, on the issuer's clock. */
  expiresAt: number;
}

export type PolymorphicVerifyReason =
  | "unknown_challenge"
  | "session_mismatch"
  | "expired"
  | "replay"
  | "bad_answer";

export interface PolymorphicChallenge {
  issue(sessionId: string): IssuedPolymorphicChallenge;
  verify(
    sessionId: string,
    challengeId: string,
    answer: string | number,
  ): { ok: boolean; reason?: PolymorphicVerifyReason };
}

/** Create a U2 per-session polymorphic challenge issuer/verifier. Opt-in. */
export function createPolymorphicChallenge(options: PolymorphicChallengeOptions): PolymorphicChallenge {
  if (typeof options?.secret !== "string" || options.secret.length === 0) {
    throw new TypeError("polymorphic challenge: a non-empty host secret is required");
  }
  const secret = options.secret;
  const ttlMs = options.ttlMs ?? U2_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("polymorphic challenge: ttlMs must be a positive finite number");
  }
  const now = options.now ?? Date.now;
  const maxOutstanding = options.maxOutstanding ?? 10_000;
  const crypto = getNodeCrypto();

  const outstanding = new Map<string, { sessionId: string; expiresAt: number; consumed: boolean }>();
  let counter = 0;

  function prune(at: number): void {
    for (const [id, rec] of outstanding) {
      if (rec.consumed || rec.expiresAt <= at) outstanding.delete(id);
    }
  }

  function issue(sessionId: string): IssuedPolymorphicChallenge {
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      throw new TypeError("polymorphic challenge: sessionId must be a non-empty string");
    }
    const at = now();
    if (outstanding.size >= maxOutstanding) prune(at);
    if (outstanding.size >= maxOutstanding) {
      throw new Error("polymorphic challenge: too many outstanding challenges");
    }
    counter += 1;
    let challengeId: string;
    if (typeof crypto.randomBytes === "function") {
      const bytes = crypto.randomBytes(16);
      challengeId = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    } else {
      challengeId = getNodeCrypto()
        .createHmac("sha256", secret)
        .update(`u2-id\0${sessionId}\0${at}\0${counter}`, "utf8")
        .digest("hex")
        .slice(0, 32);
    }
    const plan = generatePlan(secret, sessionId, challengeId);
    const expiresAt = at + ttlMs;
    outstanding.set(challengeId, { sessionId, expiresAt, consumed: false });
    return { challengeId, payload: plan.payload, entryName: plan.entryName, expiresAt };
  }

  function verify(
    sessionId: string,
    challengeId: string,
    answer: string | number,
  ): { ok: boolean; reason?: PolymorphicVerifyReason } {
    const rec = outstanding.get(challengeId);
    if (!rec) return { ok: false, reason: "unknown_challenge" };
    if (rec.consumed) return { ok: false, reason: "replay" };
    // Single use: the first attempt against a live record consumes
    // it, whatever the outcome - a failed challenge cannot be
    // probed again, and a passed one cannot be replayed.
    rec.consumed = true;
    if (now() > rec.expiresAt) return { ok: false, reason: "expired" };
    if (rec.sessionId !== sessionId) return { ok: false, reason: "session_mismatch" };
    // Recompute the expected answer from the seed; the payload is
    // never executed on the server.
    const expected = generatePlan(secret, rec.sessionId, challengeId).answer;
    const enc = new TextEncoder();
    const got = enc.encode(String(answer));
    const want = enc.encode(expected);
    const same = got.length === want.length && crypto.timingSafeEqual(got, want);
    if (!same) {
      // Keep the comparison constant-time-shaped on length mismatch
      // too: compare the expected value against itself and discard.
      crypto.timingSafeEqual(want, want);
      return { ok: false, reason: "bad_answer" };
    }
    return { ok: true };
  }

  return { issue, verify };
}
