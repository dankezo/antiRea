/**
 * Escalating VDF ladder (HV-01 x HV-02 composite, antiRea 3.3.3,
 * OPT-IN, default OFF). Scope freeze:
 * SCOPE-333-FREEZE-2026-11-25.md sections 1.5, 2.1.4, 2.2 and 4.3.
 * Measured basis: trials-333-hv-composite/
 * HV-COMPOSITE-TRIAL-REPORT-2026-11-25.md (composite trial PASS on
 * all four frozen gates, lab scale). The mechanics here are a
 * byte-for-byte semantic port of the trial harness (vdf_common.py
 * and gate_server.py in that trial directory); nothing in this
 * module re-derives, re-tunes or extends them.
 *
 * WHAT IT IS. A time-tax gate for a bulk / export path. The host
 * serves the export in batches (the trial used 50 records per
 * batch, 40 batches for a 2,000-record catalog; batching itself is
 * the host's policy, this module only prices the next batch). To
 * release batch k the client must solve a Wesolowski verifiable
 * delay function (VDF) over an RSA-2048 group whose difficulty
 * escalates geometrically per gate paid:
 *
 *   T_k = floor(300000 * 116^(k-1) / 100^(k-1)),  k = 1..40
 *   sum(T) = 708,227,155 sequential squarings
 *
 * A normal client pays only the first few cheap gates. A client
 * harvesting the whole export climbs to the expensive end of the
 * ladder (gate 40 alone is T_40 = 97,945,127 squarings).
 *
 * STATE BINDING - THE HARD DESIGN INVARIANT. Ladder state is keyed
 * ONLY by serialHash(serial) = hex(SHA-256(serial)), where serial
 * is the random serial inside a Chaum blind-signed token (Privacy
 * Pass style, ported below). No cookie, account id, IP address,
 * user agent, device fingerprint or any other identity-layer value
 * appears anywhere in ladder state, in any key, or in any input to
 * the three ladder methods: challenge, redeem and status each take
 * ONLY the token header. Identity reset survival is therefore
 * structural, not a policy: a client that resets its whole
 * identity layer (new session, no cookies, new account, new user
 * agent) and keeps its token resumes at exactly the gate it had
 * reached, because there is no identity input that could reset it.
 *
 * WHAT THE LAB MEASURED (standalone numbers for THIS mechanism
 * only, on the trial's lab twin, InstaBox webcheck-test 4 vCPU;
 * see CLAIM DISCIPLINE below for how these may be stated):
 *
 * - A full 2,000-record harvest through the gated export path
 *   (40 gates, sequential, one token, native-speed evaluator)
 *   took 1,456.48 s wall-clock.
 * - A normal legitimate export session (3 batches, Chromium with
 *   a WASM evaluator) added 7.26 s in total; the largest single
 *   gate in that session was 2.79 s.
 * - Server-side proof verification median was 0.404 ms under
 *   parallel load.
 * - Reset leg: after paying 6 gates and resetting the entire
 *   identity layer while keeping the token, the next challenge
 *   was gate 7 at T_7 = 730,918 (the frozen table value, not T_1).
 * - Negative controls held: no token -> 401, forged signature ->
 *   401, replayed proof against a later challenge -> 403, second
 *   token issue for the same device in one epoch -> 429.
 *
 * CLAIM DISCIPLINE (freeze sections 1.5, 2.1.4, 2.2 - binding on
 * anything written about this module):
 *
 * - The numbers above may be stated ONLY as standalone lab
 *   measurements of this one mechanism, with the section 1.5
 *   caveat attached: token scarcity was ASSUMED in the lab
 *   construct (the lab issuer enforced at most 1 token per
 *   device id per epoch, but anyone could mint a fresh device
 *   id); production scarcity requires platform attestation (for
 *   example Apple PAT / Privacy Pass), whose coverage outside
 *   Apple is thin, and no attestation integration is measured
 *   or claimed here.
 * - FORBIDDEN: any composite cost claim. Never add this ladder's
 *   seconds to any other mechanism's cost, and never phrase the
 *   ladder as "3.3.3 multiplies attacker cost by X". The ladder
 *   was measured standalone on the export path only; it has
 *   never been measured composed with the rest of the 3.3.3
 *   stack.
 * - FORBIDDEN: any production claim for attestation integration,
 *   for token scarcity outside the lab, for mobile timing, or
 *   for a power-user exemption. None of those are measured.
 * - This module is OPT-IN and ships default OFF. Enabling it is
 *   the host's decision, taken with the documented degraded mode
 *   in docs/VDF-LADDER.md (freeze section 4.3) in view.
 *
 * GROUP AND KEY ROLES. Two distinct RSA roles exist and are kept
 * separate, exactly as in the trial (the trial's VDF group N / g
 * came from the HV-01 probe and its issuer used a SEPARATE
 * RSA-2048 keypair):
 *
 * - The VDF group is an RSA modulus N with generator g = 2. The
 *   factorization of N must stay secret on the host: anyone who
 *   can factor N can shortcut the delay. `generateVdfGroup`
 *   returns { n, e, d } from a fresh RSA-2048 keypair as a
 *   convenience for hosts that generate their own group; the
 *   host must keep d (and the primes behind it) secret.
 * - The token issuer is its own RSA-2048 keypair { n, e, d } used
 *   for Chaum blind signatures. Do not force one key to serve
 *   both roles; the factories below take their keys separately.
 *
 * PURE CORE. vdfEval / vdfProve / vdfVerify are pure BigInt
 * computation (node:crypto is used only for SHA-256, randomness
 * and RSA key generation). All RSA / VDF arithmetic is BigInt;
 * there are no runtime dependencies beyond node: builtins.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring step-up-proof).        */
/* ------------------------------------------------------------------------ */

interface NodeHashLike {
  update(data: Uint8Array): NodeHashLike;
  digest(): Uint8Array;
}

interface NodeKeyObjectLike {
  export(options: { format: "jwk" }): { n?: string; e?: string; d?: string };
}

interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
  randomBytes(size: number): Uint8Array;
  generateKeyPairSync(
    type: "rsa",
    options: { modulusLength: number },
  ): { publicKey: NodeKeyObjectLike; privateKey: NodeKeyObjectLike };
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (
        nodeCrypto &&
        typeof nodeCrypto.createHash === "function" &&
        typeof nodeCrypto.randomBytes === "function" &&
        typeof nodeCrypto.generateKeyPairSync === "function"
      ) {
        return nodeCrypto;
      }
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; the VDF ladder requires Node.js");
}

/** Named error thrown for invalid VDF ladder inputs. */
export class VdfLadderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VdfLadderError";
  }
}

const fail = (message: string): never => {
  throw new VdfLadderError(`vdf ladder: ${message}`);
};

/* ------------------------------------------------------------------------ */
/* Byte and hash helpers.                                                   */
/* ------------------------------------------------------------------------ */

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

function sha256(...parts: Uint8Array[]): Uint8Array {
  const hash = getNodeCrypto().createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}

/** Big-endian fixed-width encoding; throws when the value does not fit. */
function bigintToBytesBE(value: bigint, length: number): Uint8Array {
  if (value < 0n) fail("cannot encode a negative value as unsigned big-endian bytes");
  const bytes = new Uint8Array(length);
  let rest = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  if (rest !== 0n) fail(`value does not fit in ${length} bytes`);
  return bytes;
}

function base64UrlToBytes(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

/* ------------------------------------------------------------------------ */
/* BigInt modular arithmetic.                                               */
/* ------------------------------------------------------------------------ */

/** Modular exponentiation: base^exponent mod modulus, all BigInt. */
export function vdfModpow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n) fail("modulus must be positive");
  if (exponent < 0n) fail("exponent must be non-negative");
  let result = 1n % modulus;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const r = x % y;
    x = y;
    y = r;
  }
  return x;
}

/** Modular inverse via the extended Euclidean algorithm. */
function modInverse(a: bigint, modulus: bigint): bigint {
  let [oldR, r] = [((a % modulus) + modulus) % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  if (oldR !== 1n) fail("value has no modular inverse (not coprime to the modulus)");
  return ((oldS % modulus) + modulus) % modulus;
}

/* ------------------------------------------------------------------------ */
/* Probable primes: deterministic Miller-Rabin over the first 40 prime      */
/* bases. This mirrors the probable-prime semantics of gmpy2.next_prime     */
/* used by the trial: a candidate that passes Miller-Rabin against the      */
/* first 40 prime bases is treated as prime, and the search steps +2        */
/* through odd candidates. (gmpy2.next_prime returns the next probable      */
/* prime STRICTLY greater than its argument; vdfNextPrime does the same.)   */
/* ------------------------------------------------------------------------ */

const FIRST_40_PRIMES: readonly bigint[] = [
  2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n,
  31n, 37n, 41n, 43n, 47n, 53n, 59n, 61n, 67n, 71n,
  73n, 79n, 83n, 89n, 97n, 101n, 103n, 107n, 109n, 113n,
  127n, 131n, 137n, 139n, 149n, 151n, 157n, 163n, 167n, 173n,
];

function isProbablePrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of FIRST_40_PRIMES) {
    if (n === p) return true;
    if (n % p === 0n) return false;
  }
  // Write n - 1 = 2^s * d with d odd.
  let d = n - 1n;
  let s = 0n;
  while ((d & 1n) === 0n) {
    d >>= 1n;
    s += 1n;
  }
  for (const a of FIRST_40_PRIMES) {
    if (a % n === 0n) continue;
    let x = vdfModpow(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let i = 1n; i < s; i++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

/** Next probable prime strictly greater than n (gmpy2.next_prime semantics). */
export function vdfNextPrime(n: bigint): bigint {
  if (n < 2n) return 2n;
  let candidate = n + 1n;
  if ((candidate & 1n) === 0n) candidate += 1n;
  while (!isProbablePrime(candidate)) candidate += 2n;
  return candidate;
}

/* ------------------------------------------------------------------------ */
/* The frozen difficulty table.                                             */
/*                                                                          */
/* T_k = floor(300000 * 116^(k-1) / 100^(k-1)) computed with exact BigInt    */
/* arithmetic (integer division of non-negative values floors, matching     */
/* the trial's Python floor division). Frozen checks, pinned by tests:      */
/* T_1 = 300000, T_7 = 730918, T_40 = 97945127, sum = 708227155.             */
/* ------------------------------------------------------------------------ */

/** The frozen escalating difficulty table, T_1 .. T_maxGate. */
export function vdfTTable(maxGate = 40): bigint[] {
  if (!Number.isInteger(maxGate) || maxGate < 1) fail("maxGate must be a positive integer");
  const table: bigint[] = [];
  for (let k = 1; k <= maxGate; k++) {
    const power = BigInt(k - 1);
    table.push((300000n * 116n ** power) / 100n ** power);
  }
  return table;
}

/* ------------------------------------------------------------------------ */
/* Wesolowski VDF core (port of vdf_common.py, byte-for-byte semantics).    */
/*                                                                          */
/* Fiat-Shamir challenge prime l: SHA-256 over                              */
/*   ASCII "hvcomp-l" || x as 256-byte big-endian || y as 256-byte          */
/*   big-endian || T as 8-byte big-endian || serial raw bytes || gate       */
/*   as 4-byte big-endian                                                   */
/* then cand = (digest mod 2^127) | 2^127 | 1 and l = nextPrime(cand).      */
/* The trial derives l Fiat-Shamir style rather than fixing it: with a      */
/* fixed l the proof is forgeable (pick pi, set y := pi^l * x^r), so a      */
/* gate with fixed l would not exist. This deviation from the HV-01         */
/* probe was frozen in the composite trial registration; eval cost is       */
/* unchanged.                                                               */
/* ------------------------------------------------------------------------ */

/** Derive the Wesolowski challenge prime l for (x, y, T, serial, gate). */
export function fiatShamirL(x: bigint, y: bigint, T: bigint, serial: Uint8Array, gate: number): bigint {
  if (!Number.isInteger(gate) || gate < 0) fail("gate must be a non-negative integer");
  const digest = sha256(
    ascii("hvcomp-l"),
    bigintToBytesBE(x, 256),
    bigintToBytesBE(y, 256),
    bigintToBytesBE(T, 8),
    serial,
    bigintToBytesBE(BigInt(gate), 4),
  );
  const cand = (bytesToBigint(digest) % (1n << 127n)) | (1n << 127n) | 1n;
  return vdfNextPrime(cand);
}

/**
 * Evaluate the VDF: y = x^(2^T) mod N, computed as T repeated
 * squarings. The repeated squaring IS the sequential delay; there
 * is deliberately no shortcut exponentiation here.
 */
export function vdfEval(x: bigint, T: bigint, N: bigint): bigint {
  if (T < 0n) fail("T must be non-negative");
  let y = ((x % N) + N) % N;
  for (let i = 0n; i < T; i++) y = (y * y) % N;
  return y;
}

export interface VdfProof {
  y: bigint;
  pi: bigint;
  l: bigint;
}

/**
 * Produce a Wesolowski proof for (x, T) bound to (serial, gate):
 * y from vdfEval, l from fiatShamirL, q = (2^T) / l by integer
 * division (2^T materialized as 1n << T), pi = x^q mod N.
 */
export function vdfProve(x: bigint, T: bigint, serial: Uint8Array, gate: number, N: bigint): VdfProof {
  const y = vdfEval(x, T, N);
  const l = fiatShamirL(x, y, T, serial, gate);
  const q = (1n << T) / l;
  const pi = vdfModpow(x, q, N);
  return { y, pi, l };
}

/**
 * Verify a Wesolowski proof: recompute l, take r = 2^T mod l by
 * fast powmod (exponent T), and check pi^l * x^r mod N == y.
 */
export function vdfVerify(
  x: bigint,
  y: bigint,
  pi: bigint,
  T: bigint,
  serial: Uint8Array,
  gate: number,
  N: bigint,
): boolean {
  // A malformed proof is a false verdict, never an exception:
  // anything the Fiat-Shamir encoding cannot represent (negative
  // or oversize x/y, negative or >= 2^64 T, gate outside the
  // 4-byte range) is rejected here instead of throwing out of the
  // byte encoders. (The ladder's redeem path feeds this function
  // requester-controlled y/pi strings.)
  if (N <= 0n) return false;
  if (x < 0n || y < 0n || pi < 0n || T < 0n) return false;
  if (x >= 1n << 2048n || y >= 1n << 2048n) return false;
  if (T >= 1n << 64n) return false;
  if (!Number.isInteger(gate) || gate < 0 || gate > 0xffffffff) return false;
  const l = fiatShamirL(x, y, T, serial, gate);
  const r = vdfModpow(2n, T, l);
  const lhs = (vdfModpow(pi, l, N) * vdfModpow(x, r, N)) % N;
  return lhs === ((y % N) + N) % N;
}

/* ------------------------------------------------------------------------ */
/* Group setup helper.                                                      */
/* ------------------------------------------------------------------------ */

export interface VdfGroup {
  n: bigint;
  e: bigint;
  d: bigint;
}

/**
 * Generate a fresh RSA-2048 keypair and return { n, e, d } as
 * bigints (via JWK export). Usable for the VDF group (with g = 2)
 * or for the token issuer; the two roles are separate options and
 * hosts should generate separate keypairs for them, as the trial
 * did. The host must keep d - and the factorization it implies -
 * secret: for the VDF group, factoring N shortcuts the delay; for
 * the issuer, d is the signing key itself.
 */
export function generateVdfGroup(): VdfGroup {
  const { publicKey, privateKey } = getNodeCrypto().generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = publicKey.export({ format: "jwk" });
  const priv = privateKey.export({ format: "jwk" });
  const jwkN = pub.n;
  const jwkE = pub.e;
  const jwkD = priv.d;
  if (!jwkN || !jwkE || !jwkD) {
    throw new VdfLadderError("vdf ladder: RSA key generation did not yield JWK n, e and d");
  }
  return {
    n: bytesToBigint(base64UrlToBytes(jwkN)),
    e: bytesToBigint(base64UrlToBytes(jwkE)),
    d: bytesToBigint(base64UrlToBytes(jwkD)),
  };
}

/* ------------------------------------------------------------------------ */
/* Blind token (Chaum), ported from vdf_common.py token_message and the     */
/* gate_server.py issuance flow.                                            */
/*                                                                          */
/* tokenMessage(serial) = SHA-256(ASCII "hvcomp-token:" || serial) read     */
/* big-endian. serialHash(serial) = hex(SHA-256(serial)) and is the ONLY     */
/* ladder key. The wire form is the trial's X-Token header:                 */
/* "<serial hex>:<signature decimal>".                                      */
/* ------------------------------------------------------------------------ */

/** The blind-signed message for a token serial. */
export function tokenMessage(serial: Uint8Array): bigint {
  return bytesToBigint(sha256(ascii("hvcomp-token:"), serial));
}

/** Hex SHA-256 of the serial - the only key ladder state is stored under. */
export function serialHash(serial: Uint8Array): string {
  return bytesToHex(sha256(serial));
}

export interface VdfTokenIssuerOptions {
  n: bigint;
  e: bigint;
  d: bigint;
  /**
   * Maximum tokens one device id may mint per epoch. Default 1,
   * matching the lab issuer. This per-device cap is the lab's
   * stand-in for attestation-enforced scarcity; see the header's
   * claim discipline and the degraded mode in docs/VDF-LADDER.md.
   */
  maxTokensPerDevicePerEpoch?: number;
}

export type VdfTokenIssueResult =
  | { ok: true; blindedSignature: bigint }
  | { ok: false; status: 429; error: "device_already_minted" };

export interface VdfTokenIssuer {
  /** Current epoch (starts at 1; rotateEpoch increments it). */
  readonly epoch: number;
  /**
   * Blind-sign a client's blinded message for a device id. When
   * the device has already minted its allowance this epoch the
   * result is { ok: false, status: 429, error:
   * "device_already_minted" } and nothing is signed.
   */
  issue(deviceId: string, blinded: bigint): VdfTokenIssueResult;
  /** Advance the epoch and clear per-device mint counts. Returns the new epoch. */
  rotateEpoch(): number;
  /** Verify an unblinded token: signature^e mod n == tokenMessage(serial). */
  verifyToken(serial: Uint8Array, signature: bigint): boolean;
}

/** Create the blind-token issuer (server side; holds d). */
export function createVdfTokenIssuer(options: VdfTokenIssuerOptions): VdfTokenIssuer {
  const { n, e, d } = options;
  if (n <= 0n || e <= 0n || d <= 0n) fail("issuer n, e and d must be positive bigints");
  const maxTokens = options.maxTokensPerDevicePerEpoch ?? 1;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    fail("maxTokensPerDevicePerEpoch must be a positive integer");
  }
  let epoch = 1;
  const minted = new Map<string, number>();
  return {
    get epoch() {
      return epoch;
    },
    issue(deviceId: string, blinded: bigint): VdfTokenIssueResult {
      if (typeof deviceId !== "string" || deviceId.length === 0) {
        fail("deviceId must be a non-empty string");
      }
      const count = minted.get(deviceId) ?? 0;
      if (count >= maxTokens) {
        return { ok: false, status: 429, error: "device_already_minted" };
      }
      const blindedSignature = vdfModpow(blinded, d, n);
      minted.set(deviceId, count + 1);
      return { ok: true, blindedSignature };
    },
    rotateEpoch(): number {
      epoch += 1;
      minted.clear();
      return epoch;
    },
    verifyToken(serial: Uint8Array, signature: bigint): boolean {
      if (signature < 0n || signature >= n) return false;
      return vdfModpow(signature, e, n) === tokenMessage(serial);
    },
  };
}

export interface VdfTokenClientOptions {
  n: bigint;
  e: bigint;
  /** Injectable randomness for tests; defaults to node:crypto randomBytes. */
  randomBytes?: (size: number) => Uint8Array;
}

export interface VdfBlindResult {
  blinded: bigint;
  blindingFactor: bigint;
}

export interface VdfTokenClient {
  /** Draw a fresh 32-byte token serial. */
  generateSerial(): Uint8Array;
  /**
   * Blind a serial for issuance: picks a random r with 1 < r < n
   * and gcd(r, n) == 1 (retrying until coprime) and returns
   * blinded = tokenMessage(serial) * r^e mod n with the factor.
   */
  blind(serial: Uint8Array): VdfBlindResult;
  /** Remove the blinding factor: blindedSignature * r^(-1) mod n. */
  unblind(blindedSignature: bigint, blindingFactor: bigint): bigint;
  /** The trial's X-Token wire form: "<serial hex>:<signature decimal>". */
  tokenHeader(serial: Uint8Array, signature: bigint): string;
}

/** Create the blind-token client (holds no secret key material). */
export function createVdfTokenClient(options: VdfTokenClientOptions): VdfTokenClient {
  const { n, e } = options;
  // n must exceed 2: blind() needs an r with 1 < r < n and
  // gcd(r, n) = 1, which does not exist for n <= 2 - without this
  // check blind() would retry forever on a degenerate modulus.
  if (n <= 2n || e <= 0n) fail("client n must be a bigint greater than 2 and e must be positive");
  const randomBytes = options.randomBytes ?? ((size: number) => getNodeCrypto().randomBytes(size));
  return {
    generateSerial(): Uint8Array {
      return randomBytes(32);
    },
    blind(serial: Uint8Array): VdfBlindResult {
      const message = tokenMessage(serial);
      const byteLength = Math.ceil(n.toString(2).length / 8);
      for (let attempt = 0; attempt < 10000; attempt++) {
        const r = bytesToBigint(randomBytes(byteLength)) % n;
        if (r <= 1n || r >= n) continue;
        if (gcd(r, n) !== 1n) continue;
        return { blinded: (message * vdfModpow(r, e, n)) % n, blindingFactor: r };
      }
      return fail("could not draw a blinding factor coprime to n after 10000 attempts");
    },
    unblind(blindedSignature: bigint, blindingFactor: bigint): bigint {
      return (blindedSignature * modInverse(blindingFactor, n)) % n;
    },
    tokenHeader(serial: Uint8Array, signature: bigint): string {
      return `${bytesToHex(serial)}:${signature.toString(10)}`;
    },
  };
}

/**
 * Parse the trial's X-Token header form, "<serial hex>:<signature
 * decimal>". Returns null on any malformation.
 */
export function parseTokenHeader(header: unknown): { serial: Uint8Array; signature: bigint } | null {
  if (typeof header !== "string") return null;
  const parts = header.split(":");
  if (parts.length !== 2) return null;
  const serialHex = parts[0] as string;
  const signatureText = parts[1] as string;
  if (serialHex.length === 0) return null;
  const serial = hexToBytes(serialHex);
  if (serial === null || serial.length === 0) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(signatureText)) return null;
  let signature: bigint;
  try {
    signature = BigInt(signatureText);
  } catch {
    return null;
  }
  return { serial, signature };
}

/* ------------------------------------------------------------------------ */
/* The ladder.                                                              */
/*                                                                          */
/* A direct port of gate_server.py's challenge / redeem / status flow       */
/* and its status codes (401 / 403 / 409, 200 on success):                  */
/*                                                                          */
/* - challenge: strictly the NEXT gate, no lookahead. A pending             */
/*   challenge is returned verbatim until redeemed. x is derived exactly    */
/*   as the trial derives it: x = g^(nonce as a big-endian integer) mod N,  */
/*   with nonce 32 random bytes (hex on the wire).                          */
/* - redeem: a wrong proof returns 403 and the ladder stays FROZEN          */
/*   (pending kept, gatesPaid unchanged) - the correct proof can still      */
/*   be presented afterwards. On success the pending nonce is re-checked    */
/*   before committing (a moved challenge returns 409); the host's         */
/*   onGatePaid hook then produces the released batch, and only after it    */
/*   returns is gatesPaid set to the paid gate and pending cleared - a      */
/*   throwing hook leaves the challenge pending and retryable.              */
/* - status: gates paid under this token, 0 for an unknown token.           */
/*                                                                          */
/* All state flows through the LadderStore under serialHash keys only.      */
/* Entry strings mirror the trial's state.json shape so stores can          */
/* serialize entries as-is.                                                 */
/* ------------------------------------------------------------------------ */

export interface LadderPending {
  gate: number;
  nonce: string;
  x: string;
  t: string;
}

export interface LadderEntry {
  gatesPaid: number;
  pending: LadderPending | null;
}

export interface LadderStore {
  get(key: string): LadderEntry | undefined;
  set(key: string, entry: LadderEntry): void;
}

/** In-memory LadderStore (single-process hosts and tests). */
export function createInMemoryLadderStore(): LadderStore {
  const map = new Map<string, LadderEntry>();
  return {
    get: (key: string) => map.get(key),
    set: (key: string, entry: LadderEntry) => {
      map.set(key, entry);
    },
  };
}

export interface VdfLadderOptions {
  /** The VDF group: RSA modulus n, generator g (default 2n, the trial value). */
  group: { n: bigint; g?: bigint };
  /** Host-side token verification (typically a VdfTokenIssuer's verifyToken). */
  verifyToken: (serial: Uint8Array, signature: bigint) => boolean;
  /** Difficulty table; defaults to the frozen vdfTTable(40). */
  tTable?: bigint[];
  /** State store; defaults to a fresh in-memory store. */
  store?: LadderStore;
  /** Injectable randomness for tests; defaults to node:crypto randomBytes. */
  randomBytes?: (size: number) => Uint8Array;
  /**
   * Host-side exemption predicate, keyed by the token's serial
   * hash. An exempt token's challenge returns
   * { status: 200, exempt: true, gatesPaid: 0 } and no ladder
   * state is written. This is the documented hook for contracted
   * bulk customers (see docs/VDF-LADDER.md, power-user section);
   * the module itself grants no exemption by default.
   */
  isExempt?: (serialHash: string) => boolean;
  /**
   * Called on each successful redeem with (serialHash, gate); its
   * return value is handed back as the redeem result's `batch`
   * (the host releases its next export batch there).
   */
  onGatePaid?: (serialHash: string, gate: number) => unknown;
}

export type VdfChallengeResult =
  | { status: 401; error: "bad token" }
  | { status: 200; exempt: true; gatesPaid: 0 }
  | { status: 409; error: "ladder complete" }
  | { status: 200; gate: number; T: string; nonce: string; x: string };

export type VdfRedeemResult =
  | { status: 401; error: "bad token" }
  | { status: 409; error: "no pending challenge" | "challenge moved" }
  | { status: 403; error: "bad proof" }
  | { status: 200; gate: number; gatesPaid: number; batch: unknown };

export type VdfStatusResult = { status: 401; error: "bad token" } | { status: 200; gatesPaid: number };

export interface VdfLadder {
  challenge(tokenHeader: unknown): VdfChallengeResult;
  redeem(tokenHeader: unknown, proof: { y: string; pi: string }): VdfRedeemResult;
  status(tokenHeader: unknown): VdfStatusResult;
}

/** Create the escalating VDF ladder (opt-in; the host wires it to its export path). */
export function createVdfLadder(options: VdfLadderOptions): VdfLadder {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const n = options.group?.n;
  if (typeof n !== "bigint" || n <= 0n) fail("group.n must be a positive bigint");
  const g = options.group.g ?? 2n;
  if (typeof options.verifyToken !== "function") fail("verifyToken must be a function");
  const verifyToken = options.verifyToken;
  const tTable = options.tTable ?? vdfTTable(40);
  if (tTable.length < 1) fail("tTable must contain at least one gate");
  const store = options.store ?? createInMemoryLadderStore();
  const randomBytes = options.randomBytes ?? ((size: number) => getNodeCrypto().randomBytes(size));
  const isExempt = options.isExempt;
  const onGatePaid = options.onGatePaid;

  function resolveToken(tokenHeader: unknown): { serial: Uint8Array; key: string } | null {
    const parsed = parseTokenHeader(tokenHeader);
    if (parsed === null) return null;
    let ok = false;
    try {
      ok = verifyToken(parsed.serial, parsed.signature);
    } catch {
      ok = false;
    }
    if (!ok) return null;
    return { serial: parsed.serial, key: serialHash(parsed.serial) };
  }

  return {
    challenge(tokenHeader: unknown): VdfChallengeResult {
      const token = resolveToken(tokenHeader);
      if (token === null) return { status: 401, error: "bad token" };
      if (isExempt && isExempt(token.key)) {
        return { status: 200, exempt: true, gatesPaid: 0 };
      }
      let entry = store.get(token.key);
      if (entry === undefined) {
        entry = { gatesPaid: 0, pending: null };
        store.set(token.key, entry);
      }
      if (entry.gatesPaid >= tTable.length) {
        return { status: 409, error: "ladder complete" };
      }
      if (entry.pending === null) {
        const gate = entry.gatesPaid + 1;
        const nonce = bytesToHex(randomBytes(32));
        const x = vdfModpow(g, BigInt(`0x${nonce}`), n);
        const t = tTable[gate - 1] as bigint;
        entry = {
          gatesPaid: entry.gatesPaid,
          pending: { gate, nonce, x: x.toString(10), t: t.toString(10) },
        };
        store.set(token.key, entry);
      }
      const pending = entry.pending as LadderPending;
      return {
        status: 200,
        gate: pending.gate,
        T: pending.t,
        nonce: pending.nonce,
        x: pending.x,
      };
    },

    redeem(tokenHeader: unknown, proof: { y: string; pi: string }): VdfRedeemResult {
      const token = resolveToken(tokenHeader);
      if (token === null) return { status: 401, error: "bad token" };
      const entry = store.get(token.key);
      if (entry === undefined || entry.pending === null) {
        return { status: 409, error: "no pending challenge" };
      }
      const pending = entry.pending;
      let ok = false;
      try {
        ok = vdfVerify(
          BigInt(pending.x),
          BigInt(proof.y),
          BigInt(proof.pi),
          BigInt(pending.t),
          token.serial,
          pending.gate,
          n,
        );
      } catch {
        ok = false;
      }
      if (!ok) return { status: 403, error: "bad proof" };
      // Re-read before committing: the challenge must not have
      // moved while the proof was being verified (trial parity).
      const current = store.get(token.key);
      if (
        current === undefined ||
        current.pending === null ||
        current.pending.nonce !== pending.nonce
      ) {
        return { status: 409, error: "challenge moved" };
      }
      const gate = current.pending.gate;
      // The hook runs BEFORE the commit: if onGatePaid throws, the
      // error propagates but the pending challenge stays intact
      // and the client can retry the same proof - the gate is
      // never left paid-but-undelivered with no recovery path.
      const batch = onGatePaid ? onGatePaid(token.key, gate) : undefined;
      store.set(token.key, { gatesPaid: gate, pending: null });
      return { status: 200, gate, gatesPaid: gate, batch };
    },

    status(tokenHeader: unknown): VdfStatusResult {
      const token = resolveToken(tokenHeader);
      if (token === null) return { status: 401, error: "bad token" };
      const entry = store.get(token.key);
      return { status: 200, gatesPaid: entry === undefined ? 0 : entry.gatesPaid };
    },
  };
}
