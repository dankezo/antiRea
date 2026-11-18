/**
 * Bulk access key authority (GATEKEY-01, antiRea 3.0 Item 2).
 *
 * Source evidence: gatekey-lab/REGISTRATION-GATEKEY-STEP0.md
 * (frozen 2026-11-16) + RESULTS-GATEKEY-STEP0.md
 * (PASS-LAB-WITH-COST; every hard gate GK-G1..GK-G9 passed) and
 * AMENDMENT-GK-G4-POLICY.md (parent decision P1: the GK-G4
 * contention cost is answered with option (d), the step-up fast
 * lane - see the drain order below), re-run in
 * RESULTS-GK-G4-RERUN.md (late-legit proof-presenting arrivals:
 * 26/26 issued at 12 h, established class unchanged at 13/13
 * within 24 h, pool and A1 economics unchanged).
 *
 * SCOPE LIMIT - read first, it bounds every claim this module
 * makes: the economics cover the TAIL, EXPORTS, and
 * BEYOND-FREE-ZONE serving ONLY. The head stays keyless by
 * design: novel head records are served without any key while
 * an identity is inside its free zone, forever, and no GATEKEY
 * number says anything about the head. A patient head-only
 * harvest is untouched by this mechanism (it is the shipped
 * herd/CUSUM layers' ground, not this module's).
 *
 * THE MECHANISM. Bulk access is a privilege surface, and what
 * is rationed is ISSUANCE, not serving. A key is a cursor-v2
 * pattern token: an HMAC-signed base64url payload checked
 * against server-side authority state; the store wins
 * unconditionally and verification fails closed with named
 * reasons. The payload allowlist is exactly the registered
 * set - v, kid, sub, chn, coh, lin, cm, iat, exp - and a token
 * carrying anything else is not a key (`unexpected_fields`).
 * TTL is 24 h. An identity holds at most ONE active key per
 * scope; re-issuance while one is active returns the SAME key
 * (idempotent - double-submit and retry-after-timeout are
 * replays of one issuance, never a branch).
 *
 * SERVING RULE (record-budget semantics: viewed = 1,
 * exported = 2, re-delivery free):
 * - re-delivery of a record already served to the identity is
 *   always free and never gated;
 * - a NOVEL record inside the host-declared HEAD may be served
 *   keylessly while the identity's keyless distinct count in
 *   the window is < F (default 150 distinct / 24 h);
 * - a NOVEL record in the TAIL may be served only under a held
 *   key whose slice covers it;
 * - an EXPORT of any novel record always requires a covering
 *   key slice, head or tail;
 * - past the trigger without a covering key, the denial
 *   carries the shipped step-up-402 shape (when the host
 *   configures a responder) - never as a first response to an
 *   untriggered identity: every 402 this module produces is
 *   the consequence of a bulk trigger (tail demand, novel
 *   export demand, or the free zone tripping).
 *
 * SLICES. Per epoch, one seeded Fisher-Yates permutation of
 * the corpus (seed = HMAC of the host secret + epoch counter);
 * the j-th key issued in the epoch draws block j, S = 150
 * records, so slices tile without overlap and are
 * non-contiguous in canonical order (lab-measured: max
 * adjacent pairs 6 <= 8, max run 3 <= 4). The payload carries
 * only the slice commitment `cm`; the slice is derived
 * server-side from the stored seed. Per-key served quota
 * q = S. Records served under a key expose that key's C39
 * watermark binding: `markRecordsUnderKey` marks an edition
 * through the value-watermark machinery with the edition id
 * derived from the key's `cm`, so leaked bulk data attributes
 * to the issuing key.
 *
 * ISSUANCE CHANNELS AND RHYTHMS (frozen lab values, all
 * host-configurable):
 * - anon: <= 1 key / 24 h / identity AND a fleet pool
 *   P_anon = 6 keys / 24 h across the whole channel. Drain
 *   order (registration + P1 amendment): step-up-proof
 *   requests first (FIFO among themselves), then
 *   established-history identities (>= 3 prior non-bulk
 *   days), then first-seen, FIFO within each class - all
 *   drawn from the same pool; a proof buys queue position,
 *   never pool expansion. The proof lane is opt-in by the
 *   requester, never demanded: the GK-G1 strata are never
 *   required to present anything.
 * - account (age >= 30 d or host-declared): <= 6 / 24 h, no
 *   pool.
 * - verified (host allowlist + valid Web Bot Auth signature,
 *   as attested by the host hook): <= 60 / 24 h, no pool.
 *   An unverified claimant receives ZERO verified keys; its
 *   requests are counted in anon accounting, never dropped
 *   silently.
 *
 * FORK / SHARING (SIS-01 semantics). A key presented by a
 * non-owner is rejected (`binding_mismatch`), never served,
 * and counted as share evidence. A predecessor key presented
 * after its successor's first use, in a client context
 * disjoint from the successor's first-use context (any two
 * of IP class / UA build / TLS class differing), is a FORK:
 * the lineage is revoked, both sides' evidence is merged
 * into one cohort (canary-echo merge semantics), and
 * re-issuance on that lineage requires a step-up proof.
 * The owner presenting its own CURRENT key from two contexts
 * and idempotent replays are NOT forks (negative controls,
 * GK-G6). Dormant sharing whose predecessor is never
 * re-presented produces no fork - the inherited SIS-01 blind
 * spot, stated, not hidden.
 *
 * STEP-UP AT ISSUANCE. An identity the host hook reports as
 * step-up-enrolled (or whose lineage was fork-revoked) must
 * present a valid step-up proof at issuance, any channel.
 * Unenrolled identities are issued silently.
 *
 * DEPLOYMENT POLICY. The head/tail split point and F are
 * host configuration, documented as deployment policy: the
 * defaults here (head 1,000 of 10,000, F = 150, S = 150,
 * P_anon = 6) are the lab freezes, not recommendations. A
 * host whose legitimate shape differs must re-derive and
 * re-measure.
 *
 * In-memory single-process authority state, like the shipped
 * record budget's default store. Pure computation on
 * node:crypto; zero runtime dependencies.
 */

import { createStepUp402Responder, type StepUp402Options, type StepUp402Response } from "./step-up-402";
import { PUBLIC_DEFAULT_SIGNING_SECRETS } from "./step-up-proof";
import { createValueWatermark, type ValueWatermarkMarkedRecord, type ValueWatermarkRecord } from "./value-watermark";

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirrors cursor-v2).              */
/* ------------------------------------------------------------------------ */

interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(): Uint8Array;
}
interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  randomBytes(size: number): Uint8Array;
}
declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHmac === "function") return nodeCrypto;
    } catch {
      /* fall through */
    }
  }
  throw new Error("node:crypto is not available in this runtime; bulk access keys require Node.js");
}

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const utf8Decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  const STEP = 0x4000;
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function tryBase64UrlDecode(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const bin = atob(padded);
    return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------ */
/* Public types.                                                            */
/* ------------------------------------------------------------------------ */

export type BulkAccessChannel = "anon" | "account" | "verified";

/** Client context fields fork detection reads (host session-context classes). */
export interface BulkClientContext {
  ip?: string;
  ua?: string;
  tls?: string;
}

export interface BulkAccessKeyOptions {
  /** Host HMAC secret. Mandatory, non-empty; never leaves the host. */
  secret: string;
  /** Corpus size N (records are indices 0..N-1). Default 10,000 (lab freeze). */
  corpusSize?: number;
  /** Head size: indices < headSize are the keyless head. Default 1,000 (lab freeze, deployment policy). */
  headSize?: number;
  /** Slice size S, also the per-key served quota q. Default 150 (lab freeze). */
  sliceSize?: number;
  /** Free zone F: keyless distinct novel head records per window. Default 150 (lab freeze, deployment policy). */
  freeZone?: number;
  /** Anon fleet pool P_anon, keys per 24 h across the channel. Default 6 (lab freeze). */
  anonPoolPerDay?: number;
  /** Per-identity per-24 h issuance rhythms by channel. Defaults: anon 1, account 6, verified 60. */
  rhythms?: Partial<Record<BulkAccessChannel, number>>;
  /** Key TTL in ms. Default 86,400,000 (24 h, frozen). */
  ttlMs?: number;
  /** Established-history threshold in prior non-bulk days. Default 3. */
  establishedThresholdDays?: number;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Host hook: is this identity currently step-up-enrolled by any shipped signal? */
  isStepUpEnrolled?: (identity: string) => boolean;
  /** Host hook: validate a presented step-up proof for this identity. When omitted, a non-empty proof value counts as presented-and-valid for the step-up GATE at issuance, but it buys NO anon fast-lane queue position: without a verifier the lane is closed and requests keep their FIFO place (3.1.0 safe default). Hosts that enroll identities for step-up should configure a verifier; without one, the gate cannot tell a real proof from a junk string. */
  verifyStepUpProof?: (identity: string, proof: unknown) => boolean;
  /** Host hook: prior non-bulk session days for an identity the host tracks itself. */
  priorNonBulkDays?: (identity: string) => number;
  /** Host hook: verified-channel standing - host allowlist AND a valid Web Bot Auth signature for this claimant. */
  verifyVerifiedClaim?: (identity: string, claim: BulkKeyRequestOptions) => boolean;
  /** Host hook: account-channel standing beyond age / declaration (optional). */
  verifyAccountStanding?: (identity: string, claim: BulkKeyRequestOptions) => boolean;
  /** When configured, bulk-trigger denials carry this responder's step-up-402 shape. */
  stepUp402?: StepUp402Options;
}

export interface BulkKeyRequestOptions {
  /** Host-declared cohort id carried into the payload as `coh`. */
  cohortId?: string;
  /** True when the host declares this identity (account standing / cohort membership). */
  declared?: boolean;
  /** Account age in days (account channel standing: >= 30, or declared). */
  accountAgeDays?: number;
  /** Host-attested: the claimant is on the host's verified allowlist. */
  allowlisted?: boolean;
  /** Host-attested: the claimant presented a valid Web Bot Auth signature. */
  webBotAuthVerified?: boolean;
  /** A step-up proof presented at issuance (enrolled identities, forked lineages, or the opt-in anon fast lane). */
  stepUpProof?: unknown;
  /** Host-known prior non-bulk session days for this identity (established class). */
  priorNonBulkDays?: number;
  /** Anon channel only: enqueue without draining (the host drains at day-start). */
  queueOnly?: boolean;
}

export interface BulkKeyInfo {
  kid: string;
  sub: string;
  chn: BulkAccessChannel;
  coh: string | null;
  lin: string | null;
  cm: string;
  iat: number;
  exp: number;
  epoch: number;
  block: number;
  servedCount: number;
  exhausted: boolean;
  revoked: boolean;
}

export type BulkKeyRequestStatus =
  | "issued"
  | "replay"
  | "queued"
  | "step_up_required"
  | "rhythm"
  | "standing";

export interface BulkKeyRequestResult {
  status: BulkKeyRequestStatus;
  channel: BulkAccessChannel;
  /** The key token; present on `issued` and `replay`. */
  token?: string;
  key?: BulkKeyInfo;
  /** Verified-channel failure only: the request fell to anon accounting (counted, not dropped). */
  anonAccounted?: boolean;
}

export type BulkKeyVerifyFailure =
  | "malformed"
  | "unexpected_fields"
  | "bad_signature"
  | "unknown_key"
  | "store_mismatch"
  | "expired"
  | "not_yet_valid"
  | "binding_mismatch"
  | "revoked";

export type BulkPresentResult =
  | { accepted: true; fork: boolean; key: BulkKeyInfo }
  | { accepted: false; reason: BulkKeyVerifyFailure; fork: boolean };

export type BulkServeFailure =
  | BulkKeyVerifyFailure
  | "unknown_record"
  | "tail_needs_key"
  | "export_needs_key"
  | "free_zone_tripped"
  | "not_in_slice"
  | "quota";

export type BulkServeResult =
  | {
      ok: true;
      redelivery?: boolean;
      exported?: boolean;
      /** Kid of the covering key, when served under a key. */
      kid?: string;
      /** The covering key's slice commitment - the C39 watermark binding for records served under it. */
      cm?: string;
    }
  | {
      ok: false;
      reason: BulkServeFailure;
      fork?: boolean;
      /** True when this denial is a bulk trigger and the step-up shape applies. */
      stepUpRequired?: boolean;
      /** The shipped step-up-402 response shape, when a responder is configured. */
      stepUp402?: StepUp402Response;
    };

export interface BulkForkEvent {
  /** Kid of the predecessor whose presentation fired the fork. */
  kid: string;
  /** Kid at the root of the revoked lineage. */
  rootKid: string;
  at: number;
}

export interface BulkAccessKeyStats {
  poolUsedToday: number;
  anonPoolPerDay: number;
  pendingAnonRequests: number;
  totalIssuedByChannel: Record<BulkAccessChannel, number>;
  /** Verified-channel requests by unverified claimants, counted in anon accounting. */
  anonAccounted: number;
  shareEvidence: number;
  forks: BulkForkEvent[];
  mergedCohorts: { rootKid: string; at: number }[];
  stepUpDemands: { sub: string; at: number }[];
}

export interface BulkAccessKeyAuthority {
  /**
   * Request a key on a channel. Account and verified channels mint
   * immediately (standing, step-up, single-active replay and rhythm
   * permitting). The anon channel enqueues the request and drains
   * the pool queue (unless `queueOnly` is set, for hosts that drain
   * at day-start): the result is `issued` / `replay` when the drain
   * reached this identity, otherwise `queued`.
   */
  requestKey(identity: string, channel: BulkAccessChannel, opts?: BulkKeyRequestOptions): BulkKeyRequestResult;
  /** Drain the anon pool queue in the frozen order; returns one result per request the drain settled. */
  drainAnonPool(): BulkKeyRequestResult[];
  /** Record one non-bulk session day for an identity (established-history accounting). */
  noteNonBulkSession(identity: string): void;
  /** True when the identity currently sits in the established class. */
  isEstablished(identity: string, opts?: BulkKeyRequestOptions): boolean;
  /**
   * Serve one record (by corpus index) to an identity under the
   * serving rule. Pass the presented key token when the client
   * presents one; without a token the identity's active key is
   * used. `exported: true` prices the request as an export.
   */
  serve(
    identity: string,
    record: number,
    opts?: { keyToken?: string; exported?: boolean; context?: BulkClientContext },
  ): BulkServeResult;
  /** Present a key token without serving: binding, share-evidence and fork semantics run here. */
  presentKey(identity: string, token: string, context?: BulkClientContext): BulkPresentResult;
  /** Server-side key record for a token or kid (the store's truth; never derived from the token alone). */
  keyInfo(tokenOrKid: string): BulkKeyInfo | undefined;
  /** Server-side slice derivation for a kid: the record indices this key covers. Host-side only - never ship to clients. */
  sliceForKey(kid: string): number[] | undefined;
  /** Mark records as served under a key, through the C39 value-watermark machinery with the edition bound to the key's `cm`. */
  markRecordsUnderKey(
    kid: string,
    records: ValueWatermarkRecord[],
  ): ValueWatermarkMarkedRecord[] | undefined;
  stats(): BulkAccessKeyStats;
}

/** Named error thrown for invalid bulk-access-key authority options. */
export class BulkAccessKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BulkAccessKeyError";
  }
}

export const BULK_ACCESS_KEY_TTL_MS = 86_400_000;
export const BULK_ACCESS_KEY_PAYLOAD_KEYS = ["v", "kid", "sub", "chn", "coh", "lin", "cm", "iat", "exp"] as const;

const DAY_MS = 86_400_000;
const IAT_SKEW_MS = 60_000;
const PAYLOAD_KEY_SET = new Set<string>(BULK_ACCESS_KEY_PAYLOAD_KEYS);
const CHANNELS = new Set<string>(["anon", "account", "verified"]);

interface KeyRecord {
  kid: string;
  sub: string;
  chn: BulkAccessChannel;
  coh: string | null;
  lin: string | null;
  cm: string;
  iat: number;
  exp: number;
  epoch: number;
  block: number;
  slice: Set<number>;
  servedSet: Set<number>;
  exhausted: boolean;
  revoked: boolean;
  successorKid: string | null;
  firstUseCtx: BulkClientContext | null;
  token: string;
}

interface IdentityState {
  id: string;
  served: Set<number>;
  exported: Set<number>;
  keylessDay: number;
  keylessSet: Set<number>;
  activeKid: string | null;
  lastKid: string | null;
  stepUpRequired: boolean;
  anonFallbackCount: number;
  nonBulkDayBuckets: Set<number>;
  pending: QueueEntry | null;
}

interface QueueEntry {
  ident: IdentityState;
  opts: BulkKeyRequestOptions;
  queuedAt: number;
  seq: number;
  proofValid: boolean;
  rhythmBlockedDay: number;
}

interface KeyPayload {
  v: 1;
  kid: string;
  sub: string;
  chn: BulkAccessChannel;
  coh: string | null;
  lin: string | null;
  cm: string;
  iat: number;
  exp: number;
}

export function createBulkAccessKeyAuthority(options: BulkAccessKeyOptions): BulkAccessKeyAuthority {
  if (typeof options !== "object" || options === null) {
    throw new BulkAccessKeyError("createBulkAccessKeyAuthority: options are required");
  }
  const secret = options.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new BulkAccessKeyError("createBulkAccessKeyAuthority: options.secret must be a non-empty string");
  }
  // ABS-01: a secret equal to a known public default is a missing
  // secret wearing a costume - anyone who read the neighbour source
  // could mint keys under it. Fail closed at construction.
  if (PUBLIC_DEFAULT_SIGNING_SECRETS.includes(secret)) {
    throw new BulkAccessKeyError(
      "createBulkAccessKeyAuthority: options.secret must not be a known public default value (ABS-01)",
    );
  }
  const posInt = (value: number | undefined, fallback: number, field: string): number => {
    const n = Math.floor(value ?? fallback);
    if (!Number.isFinite(n) || n < 1) throw new BulkAccessKeyError(`createBulkAccessKeyAuthority: ${field} must be a positive integer`);
    return n;
  };
  const corpusSize = posInt(options.corpusSize, 10_000, "corpusSize");
  const headSize = Math.min(corpusSize, posInt(options.headSize, 1_000, "headSize"));
  const sliceSize = posInt(options.sliceSize, 150, "sliceSize");
  const freeZone = posInt(options.freeZone, 150, "freeZone");
  const anonPoolPerDay = posInt(options.anonPoolPerDay, 6, "anonPoolPerDay");
  const ttlMs = posInt(options.ttlMs, BULK_ACCESS_KEY_TTL_MS, "ttlMs");
  const establishedThreshold = posInt(options.establishedThresholdDays, 3, "establishedThresholdDays");
  const rhythms: Record<BulkAccessChannel, number> = {
    anon: posInt(options.rhythms?.anon, 1, "rhythms.anon"),
    account: posInt(options.rhythms?.account, 6, "rhythms.account"),
    verified: posInt(options.rhythms?.verified, 60, "rhythms.verified"),
  };
  const clock = options.now ?? (() => Date.now());
  const numBlocks = Math.ceil(corpusSize / sliceSize);
  const responder = options.stepUp402 ? createStepUp402Responder(options.stepUp402) : undefined;
  const watermark = createValueWatermark({ key: secret });

  const sign = (data: string): Uint8Array => getNodeCrypto().createHmac("sha256", secret).update(data).digest();
  const hmacHex = (data: string): string =>
    Array.from(sign(data), (b) => b.toString(16).padStart(2, "0")).join("");

  /* ---- epoch permutations: seed = HMAC(host secret + epoch) ---- */
  const epochCache = new Map<number, { blocks: Set<number>[] }>();
  function epochBlocks(epoch: number): Set<number>[] {
    const hit = epochCache.get(epoch);
    if (hit) return hit.blocks;
    // Shuffle entropy (3.1.0 fix): the Fisher-Yates draws come from
    // a counter-mode HMAC stream keyed with the host secret and the
    // epoch, so the permutation carries the full 256-bit HMAC
    // output per stream block. The pre-3.1.0 derivation seeded
    // mulberry32 with only the first 4 bytes of the epoch HMAC,
    // which made the whole permutation a function of a 32-bit
    // value: one observed slice (block 66 is the only short block
    // and identifies itself) was enough to brute-force the seed
    // space and rebuild every other block in the epoch.
    let streamBlock: Uint8Array = new Uint8Array(0);
    let streamPos = 0;
    let streamCounter = 0;
    const nextUint32 = (): number => {
      if (streamPos + 4 > streamBlock.length) {
        streamBlock = sign(`gatekey-epoch-stream:${epoch}:${streamCounter++}`);
        streamPos = 0;
      }
      const v = (((streamBlock[streamPos] as number) << 24) |
        ((streamBlock[streamPos + 1] as number) << 16) |
        ((streamBlock[streamPos + 2] as number) << 8) |
        (streamBlock[streamPos + 3] as number)) >>> 0;
      streamPos += 4;
      return v;
    };
    const randBelow = (n: number): number => {
      // Rejection sampling, so the shuffle draws carry no modulo bias.
      const limit = Math.floor(0x1_0000_0000 / n) * n;
      let x = nextUint32();
      while (x >= limit) x = nextUint32();
      return x % n;
    };
    const perm = Array.from({ length: corpusSize }, (_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      const j = randBelow(i + 1);
      const t = perm[i] as number;
      perm[i] = perm[j] as number;
      perm[j] = t;
    }
    const blocks: Set<number>[] = [];
    for (let j = 0; j * sliceSize < corpusSize; j++) blocks.push(new Set(perm.slice(j * sliceSize, (j + 1) * sliceSize)));
    epochCache.set(epoch, { blocks });
    return blocks;
  }

  /* ---- authority state (the store; it wins) ---- */
  const keys = new Map<string, KeyRecord>();
  const identities = new Map<string, IdentityState>();
  const rhythmCounts = new Map<string, number>();
  const queue: QueueEntry[] = [];
  let seqCounter = 0;
  let nextBlockGlobal = 0;
  let poolDay = -1;
  let poolUsed = 0;
  let anonAccountedTotal = 0;
  let shareEvidence = 0;
  const forks: BulkForkEvent[] = [];
  const mergedCohorts: { rootKid: string; at: number }[] = [];
  const stepUpDemands: { sub: string; at: number }[] = [];
  const totalIssuedByChannel: Record<BulkAccessChannel, number> = { anon: 0, account: 0, verified: 0 };

  const now = (): number => clock();
  const dayBucket = (t: number): number => Math.floor(t / DAY_MS);

  function identityState(id: string): IdentityState {
    let st = identities.get(id);
    if (!st) {
      st = {
        id,
        served: new Set(),
        exported: new Set(),
        keylessDay: -1,
        keylessSet: new Set(),
        activeKid: null,
        lastKid: null,
        stepUpRequired: false,
        anonFallbackCount: 0,
        nonBulkDayBuckets: new Set(),
        pending: null,
      };
      identities.set(id, st);
    }
    return st;
  }

  function keyInfoOf(key: KeyRecord): BulkKeyInfo {
    return {
      kid: key.kid,
      sub: key.sub,
      chn: key.chn,
      coh: key.coh,
      lin: key.lin,
      cm: key.cm,
      iat: key.iat,
      exp: key.exp,
      epoch: key.epoch,
      block: key.block,
      servedCount: key.servedSet.size,
      exhausted: key.exhausted,
      revoked: key.revoked,
    };
  }

  function keyActive(key: KeyRecord | undefined, t: number): key is KeyRecord {
    return !!key && !key.revoked && !key.exhausted && t < key.exp;
  }
  function activeKeyOf(st: IdentityState, t: number): KeyRecord | null {
    if (st.activeKid == null) return null;
    const k = keys.get(st.activeKid);
    return keyActive(k, t) ? k : null;
  }

  function proofValid(identity: string, proof: unknown): boolean {
    if (proof === undefined || proof === null || proof === false || proof === "") return false;
    if (options.verifyStepUpProof) {
      try {
        return !!options.verifyStepUpProof(identity, proof);
      } catch {
        return false;
      }
    }
    return true;
  }
  // Queue-lane proof standing (3.1.0 safe default): a presented
  // proof buys fast-lane position in the anon drain order ONLY
  // when the host configured a verifier and the verifier accepts
  // it. With no verifier configured the lane is closed and every
  // request keeps its plain FIFO place. Before 3.1.0 any non-empty
  // proof counted as valid, so junk proofs let sybils sort ahead
  // of honest waiters and take the whole shared anon pool. The
  // step-up GATE in mint keeps the presented-and-valid default
  // documented on verifyStepUpProof; the lane is the surface that
  // spends the shared pool, so the lane is what fails closed.
  function laneProofValid(identity: string, proof: unknown): boolean {
    if (!options.verifyStepUpProof) return false;
    return proofValid(identity, proof);
  }
  function enrolled(st: IdentityState): boolean {
    if (st.stepUpRequired) return true;
    if (options.isStepUpEnrolled) {
      try {
        return !!options.isStepUpEnrolled(st.id);
      } catch {
        return false;
      }
    }
    return false;
  }
  function priorDays(st: IdentityState, opts?: BulkKeyRequestOptions): number {
    let days = st.nonBulkDayBuckets.size;
    if (opts && typeof opts.priorNonBulkDays === "number" && Number.isFinite(opts.priorNonBulkDays)) {
      days = Math.max(days, Math.floor(opts.priorNonBulkDays));
    }
    if (options.priorNonBulkDays) {
      try {
        const host = options.priorNonBulkDays(st.id);
        if (Number.isFinite(host)) days = Math.max(days, Math.floor(host));
      } catch {
        /* host hook failure never grants standing */
      }
    }
    return days;
  }
  function isEstablished(st: IdentityState, opts?: BulkKeyRequestOptions): boolean {
    return priorDays(st, opts) >= establishedThreshold;
  }

  function rhythmCount(day: number, sub: string, chn: BulkAccessChannel): number {
    return rhythmCounts.get(`${day}|${sub}|${chn}`) ?? 0;
  }
  function rhythmBump(day: number, sub: string, chn: BulkAccessChannel): void {
    rhythmCounts.set(`${day}|${sub}|${chn}`, rhythmCount(day, sub, chn) + 1);
  }
  function refreshPool(t: number): void {
    const d = dayBucket(t);
    if (d !== poolDay) {
      poolDay = d;
      poolUsed = 0;
    }
  }

  /* ---- minting ---- */
  function mint(
    st: IdentityState,
    chn: BulkAccessChannel,
    opts: BulkKeyRequestOptions,
    proofAlreadyValid?: boolean,
  ): BulkKeyRequestResult {
    const t = now();
    const day = dayBucket(t);
    // Standing (registration 1.5).
    if (chn === "account") {
      const declaredStanding = !!opts.declared || typeof opts.cohortId === "string";
      let hookStanding = false;
      if (options.verifyAccountStanding) {
        try {
          hookStanding = !!options.verifyAccountStanding(st.id, opts);
        } catch {
          hookStanding = false;
        }
      }
      if (!((typeof opts.accountAgeDays === "number" && opts.accountAgeDays >= 30) || declaredStanding || hookStanding)) {
        return { status: "standing", channel: chn };
      }
    }
    if (chn === "verified") {
      let verified = false;
      if (options.verifyVerifiedClaim) {
        try {
          verified = !!options.verifyVerifiedClaim(st.id, opts);
        } catch {
          verified = false;
        }
      } else {
        verified = !!opts.allowlisted && !!opts.webBotAuthVerified;
      }
      if (!verified) {
        // GK-G8: zero verified keys; the request falls to anon
        // accounting - counted, never dropped silently.
        anonAccountedTotal++;
        st.anonFallbackCount++;
        return { status: "standing", channel: chn, anonAccounted: true };
      }
    }
    // Step-up at issuance (registration 2 + fork rule 1.6).
    if (enrolled(st) && !(proofAlreadyValid ?? proofValid(st.id, opts.stepUpProof))) {
      stepUpDemands.push({ sub: st.id, at: t });
      return { status: "step_up_required", channel: chn };
    }
    // Single-active-key: idempotent replay returns the SAME key.
    const active = activeKeyOf(st, t);
    if (active) return { status: "replay", channel: chn, token: active.token, key: keyInfoOf(active) };
    // Rhythm.
    if (rhythmCount(day, st.id, chn) >= rhythms[chn]) return { status: "rhythm", channel: chn };
    // Mint: the next block of the current epoch's permutation.
    const globalIdx = nextBlockGlobal++;
    const epoch = Math.floor(globalIdx / numBlocks);
    const block = globalIdx % numBlocks;
    const slice = epochBlocks(epoch)[block] as Set<number>;
    const kid = base64UrlEncode(getNodeCrypto().randomBytes(16));
    const cm = hmacHex(`${kid}|${epoch}:${block}`);
    const payload: KeyPayload = {
      v: 1,
      kid,
      sub: st.id,
      chn,
      coh: typeof opts.cohortId === "string" ? opts.cohortId : null,
      lin: st.lastKid,
      cm,
      iat: t,
      exp: t + ttlMs,
    };
    const payloadPart = base64UrlEncode(utf8Encode(JSON.stringify(payload)));
    const token = `${payloadPart}.${base64UrlEncode(sign(payloadPart))}`;
    const record: KeyRecord = {
      ...payload,
      epoch,
      block,
      slice,
      servedSet: new Set(),
      exhausted: false,
      revoked: false,
      successorKid: null,
      firstUseCtx: null,
      token,
    };
    keys.set(kid, record);
    if (st.lastKid != null) {
      const prev = keys.get(st.lastKid);
      if (prev) prev.successorKid = kid;
    }
    st.lastKid = kid;
    st.activeKid = kid;
    rhythmBump(day, st.id, chn);
    totalIssuedByChannel[chn]++;
    return { status: "issued", channel: chn, token, key: keyInfoOf(record) };
  }

  /* ---- anon queue + drain (registration 2 + P1 fast lane) ---- */
  function entryBefore(a: QueueEntry, b: QueueEntry): boolean {
    // P1 (AMENDMENT-GK-G4-POLICY, option (d)): proof-carrying
    // requests before ALL non-proof requests, FIFO among
    // themselves - same pool, position only.
    if (a.proofValid !== b.proofValid) return a.proofValid;
    if (a.proofValid && b.proofValid) {
      if (a.queuedAt !== b.queuedAt) return a.queuedAt < b.queuedAt;
      return a.seq < b.seq;
    }
    const ea = isEstablished(a.ident, a.opts);
    const eb = isEstablished(b.ident, b.opts);
    if (ea !== eb) return ea;
    if (a.queuedAt !== b.queuedAt) return a.queuedAt < b.queuedAt;
    return a.seq < b.seq;
  }

  function drainAnonPoolInternal(): { sub: string; result: BulkKeyRequestResult }[] {
    const t = now();
    refreshPool(t);
    const day = dayBucket(t);
    const settled: { sub: string; result: BulkKeyRequestResult }[] = [];
    const attempted = new Set<QueueEntry>();
    for (;;) {
      if (poolUsed >= anonPoolPerDay) break;
      let bestIdx = -1;
      for (let i = 0; i < queue.length; i++) {
        const e = queue[i] as QueueEntry;
        if (attempted.has(e) || e.rhythmBlockedDay === day) continue;
        if (bestIdx < 0 || entryBefore(e, queue[bestIdx] as QueueEntry)) bestIdx = i;
      }
      if (bestIdx < 0) break;
      const entry = queue[bestIdx] as QueueEntry;
      attempted.add(entry);
      const res = mint(entry.ident, "anon", entry.opts, entry.proofValid);
      if (res.status === "issued") {
        queue.splice(bestIdx, 1);
        entry.ident.pending = null;
        poolUsed++;
        settled.push({ sub: entry.ident.id, result: res });
      } else if (res.status === "replay") {
        queue.splice(bestIdx, 1);
        entry.ident.pending = null;
        settled.push({ sub: entry.ident.id, result: res });
      } else if (res.status === "rhythm") {
        entry.rhythmBlockedDay = day;
      } else {
        // standing / step_up_required: the request is settled as a
        // refusal (demands are recorded inside mint).
        queue.splice(bestIdx, 1);
        entry.ident.pending = null;
        settled.push({ sub: entry.ident.id, result: res });
      }
    }
    return settled;
  }

  function drainAnonPool(): BulkKeyRequestResult[] {
    return drainAnonPoolInternal().map((e) => e.result);
  }

  function requestKey(identity: string, channel: BulkAccessChannel, opts: BulkKeyRequestOptions = {}): BulkKeyRequestResult {
    if (typeof identity !== "string" || identity.length === 0) {
      throw new BulkAccessKeyError("requestKey: identity must be a non-empty string");
    }
    if (!CHANNELS.has(channel)) throw new BulkAccessKeyError("requestKey: channel must be anon | account | verified");
    const st = identityState(identity);
    if (channel !== "anon") return mint(st, channel, opts);
    // Idempotent claim (3.1.0 fix): an identity that already holds
    // an active key gets that SAME key back immediately, without
    // enqueueing and without touching the pool. Before this, the
    // only path back to a minted key was the anon drain, and the
    // drain stops at the pool cap before it can reach mint's
    // replay branch - so a key minted inside ANOTHER identity's
    // requestKey call (the day-rollover refill) was stranded: the
    // pool was debited, the token was returned to nobody, and its
    // owner had no call that could ever claim it. The step-up gate
    // runs first, exactly as in mint; a stale pending entry is
    // satisfied by the held key (single-active rule) and dropped.
    const active = activeKeyOf(st, now());
    if (active) {
      if (st.pending) {
        const idx = queue.indexOf(st.pending);
        if (idx >= 0) queue.splice(idx, 1);
        st.pending = null;
      }
      if (enrolled(st) && !proofValid(st.id, opts.stepUpProof)) {
        stepUpDemands.push({ sub: st.id, at: now() });
        return { status: "step_up_required", channel };
      }
      return { status: "replay", channel, token: active.token, key: keyInfoOf(active) };
    }
    // Anon: enqueue (a standing request is one request), then drain
    // unless the host drains at day-start itself.
    if (!st.pending) {
      const entry: QueueEntry = {
        ident: st,
        opts,
        queuedAt: now(),
        seq: seqCounter++,
        proofValid: laneProofValid(identity, opts.stepUpProof),
        rhythmBlockedDay: -1,
      };
      st.pending = entry;
      queue.push(entry);
    }
    if (opts.queueOnly) return { status: "queued", channel };
    const settled = drainAnonPoolInternal();
    const mine = settled.find((e) => e.sub === identity);
    if (mine) return mine.result;
    return { status: "queued", channel };
  }

  /* ---- token verification: store wins, fail closed ---- */
  type ResolveOutcome =
    | { ok: true; key: KeyRecord; fork: boolean }
    | { ok: false; reason: BulkKeyVerifyFailure; fork: boolean; key?: KeyRecord };

  function ctxDisjoint(a: BulkClientContext, b: BulkClientContext): boolean {
    let diff = 0;
    if (a.ip !== b.ip) diff++;
    if (a.ua !== b.ua) diff++;
    if (a.tls !== b.tls) diff++;
    return diff >= 2;
  }

  function fireFork(predecessor: KeyRecord): boolean {
    const rootKid = predecessor.lin ?? predecessor.kid;
    if (forks.some((f) => f.kid === predecessor.kid)) return true;
    forks.push({ kid: predecessor.kid, rootKid, at: now() });
    // Revoke the whole lineage forward from the predecessor, and
    // merge the evidence into one cohort (canary-echo semantics).
    let cur: KeyRecord | undefined = predecessor;
    while (cur) {
      cur.revoked = true;
      cur = cur.successorKid != null ? keys.get(cur.successorKid) : undefined;
    }
    mergedCohorts.push({ rootKid, at: now() });
    const owner = identityState(predecessor.sub);
    owner.stepUpRequired = true;
    if (owner.activeKid != null) {
      const active = keys.get(owner.activeKid);
      if (active && active.revoked) owner.activeKid = null;
    }
    return true;
  }

  function resolvePresented(presenter: string, token: string, ctx?: BulkClientContext): ResolveOutcome {
    const fail = (reason: BulkKeyVerifyFailure, key?: KeyRecord): ResolveOutcome => ({ ok: false, reason, fork: false, ...(key ? { key } : {}) });
    if (typeof token !== "string" || token.length === 0 || token.length > 8192) return fail("malformed");
    const dot = token.indexOf(".");
    if (dot <= 0 || dot === token.length - 1 || token.indexOf(".", dot + 1) !== -1) return fail("malformed");
    const payloadPart = token.slice(0, dot);
    const signaturePart = token.slice(dot + 1);
    const payloadBytes = tryBase64UrlDecode(payloadPart);
    if (!payloadBytes) return fail("malformed");
    let payload: KeyPayload;
    try {
      const parsed: unknown = JSON.parse(utf8Decode(payloadBytes));
      if (typeof parsed !== "object" || parsed === null) return fail("malformed");
      for (const k of Object.keys(parsed)) if (!PAYLOAD_KEY_SET.has(k)) return fail("unexpected_fields");
      const c = parsed as Partial<KeyPayload>;
      if (
        c.v !== 1 ||
        typeof c.kid !== "string" || c.kid.length === 0 ||
        typeof c.sub !== "string" || c.sub.length === 0 ||
        typeof c.chn !== "string" || !CHANNELS.has(c.chn) ||
        !(c.coh === null || typeof c.coh === "string") ||
        !(c.lin === null || typeof c.lin === "string") ||
        typeof c.cm !== "string" || c.cm.length === 0 ||
        typeof c.iat !== "number" || !Number.isFinite(c.iat) ||
        typeof c.exp !== "number" || !Number.isFinite(c.exp)
      ) {
        return fail("malformed");
      }
      payload = c as KeyPayload;
    } catch {
      return fail("malformed");
    }
    const presented = tryBase64UrlDecode(signaturePart);
    if (!presented) return fail("bad_signature");
    const expected = sign(payloadPart);
    if (presented.length !== expected.length || !getNodeCrypto().timingSafeEqual(presented, expected)) {
      return fail("bad_signature");
    }
    // Store wins: the stored record is the truth, the token only
    // names it. Any divergence is a store mismatch, never an upgrade.
    const stored = keys.get(payload.kid);
    if (!stored) return fail("unknown_key");
    if (
      stored.sub !== payload.sub || stored.chn !== payload.chn || stored.coh !== payload.coh ||
      stored.lin !== payload.lin || stored.cm !== payload.cm || stored.iat !== payload.iat || stored.exp !== payload.exp
    ) {
      return fail("store_mismatch", stored);
    }
    const t = now();
    // Store state wins over temporal checks for the owner: a
    // revoked token reports `revoked` however old it also is.
    // Non-owners fall through to the binding verdict below, so
    // their share evidence is still counted.
    if (stored.revoked && payload.sub === presenter) return fail("revoked", stored);
    if (t >= payload.exp) return fail("expired", stored);
    if (payload.iat > t + IAT_SKEW_MS) return fail("not_yet_valid", stored);
    // Fork check runs before the binding verdict (lab order): a
    // predecessor presented after its successor's first use, from a
    // disjoint context, forks the lineage whoever presents it.
    let fork = false;
    if (ctx && stored.successorKid != null) {
      const succ = keys.get(stored.successorKid);
      if (succ && succ.firstUseCtx && ctxDisjoint(ctx, succ.firstUseCtx)) fork = fireFork(stored);
    }
    if (stored.sub !== presenter) {
      shareEvidence++;
      return { ok: false, reason: "binding_mismatch", fork, key: stored };
    }
    if (stored.revoked) return { ok: false, reason: "revoked", fork, key: stored };
    return { ok: true, key: stored, fork };
  }

  function presentKey(identity: string, token: string, context?: BulkClientContext): BulkPresentResult {
    const res = resolvePresented(identity, token, context);
    if (!res.ok) return { accepted: false, reason: res.reason, fork: res.fork };
    return { accepted: true, fork: res.fork, key: keyInfoOf(res.key) };
  }

  /* ---- serving ---- */
  function stepUpDenial(identity: string, reason: BulkServeFailure): BulkServeResult {
    return {
      ok: false,
      reason,
      stepUpRequired: true,
      ...(responder ? { stepUp402: responder.respond(identity, "bulk-access-key") } : {}),
    };
  }

  function serveUnderKey(st: IdentityState, key: KeyRecord, record: number, exported: boolean, ctx?: BulkClientContext): BulkServeResult {
    if (!key.slice.has(record)) return { ok: false, reason: "not_in_slice" };
    if (key.revoked) return { ok: false, reason: "revoked" };
    if (!key.servedSet.has(record)) {
      if (key.servedSet.size >= sliceSize) return { ok: false, reason: "quota" };
      key.servedSet.add(record);
      if (key.servedSet.size >= key.slice.size || key.servedSet.size >= sliceSize) {
        key.exhausted = true;
        if (st.activeKid === key.kid) st.activeKid = null;
      }
    }
    st.served.add(record);
    if (exported) st.exported.add(record);
    if (!key.firstUseCtx && ctx) key.firstUseCtx = ctx;
    return { ok: true, ...(exported ? { exported: true } : {}), kid: key.kid, cm: key.cm };
  }

  function serve(
    identity: string,
    record: number,
    opts: { keyToken?: string; exported?: boolean; context?: BulkClientContext } = {},
  ): BulkServeResult {
    if (typeof identity !== "string" || identity.length === 0) {
      throw new BulkAccessKeyError("serve: identity must be a non-empty string");
    }
    const st = identityState(identity);
    const exported = !!opts.exported;
    if (!Number.isInteger(record) || record < 0 || record >= corpusSize) return { ok: false, reason: "unknown_record" };
    // Resolve a presented key first: its binding / fork / share
    // semantics run even when the record itself would be keyless.
    let presentedKey: KeyRecord | null = null;
    if (opts.keyToken !== undefined) {
      const res = resolvePresented(identity, opts.keyToken, opts.context);
      if (!res.ok) return { ok: false, reason: res.reason, ...(res.fork ? { fork: true } : {}) };
      presentedKey = res.key;
    }
    // A presented key that covers the record serves it under the
    // key even when the record is not novel to the identity:
    // presenting a slice record under the key registers it in the
    // KEY's delivered set (that is what exhausts the key at
    // quota), while the identity is never double-charged - the
    // record enters its served set once (lab a11y reading).
    if (presentedKey && presentedKey.slice.has(record) && (!exported || !st.exported.has(record))) {
      return serveUnderKey(st, presentedKey, record, exported, opts.context);
    }
    // Re-delivery is always free (record-budget state machine).
    if (st.served.has(record) && (!exported || st.exported.has(record))) {
      return { ok: true, redelivery: true };
    }
    const t = now();
    const covering = (): KeyRecord | null => {
      if (presentedKey && presentedKey.slice.has(record) && !presentedKey.revoked) return presentedKey;
      const active = activeKeyOf(st, t);
      if (active && active.slice.has(record)) return active;
      return null;
    };
    if (exported) {
      // Novel exports are never keyless, head or tail.
      const key = covering();
      if (!key) return stepUpDenial(identity, "export_needs_key");
      return serveUnderKey(st, key, record, true, opts.context);
    }
    if (record >= headSize) {
      const key = covering();
      if (!key) {
        if (presentedKey) return { ok: false, reason: "not_in_slice" };
        return stepUpDenial(identity, "tail_needs_key");
      }
      return serveUnderKey(st, key, record, false, opts.context);
    }
    // Novel head record: keyless inside the free zone.
    const day = dayBucket(t);
    if (st.keylessDay !== day) {
      st.keylessDay = day;
      st.keylessSet = new Set();
    }
    if (st.keylessSet.size < freeZone) {
      st.keylessSet.add(record);
      st.served.add(record);
      return { ok: true };
    }
    // Past the trigger: a covering key serves it, else the 402 shape.
    const key = covering();
    if (!key) return stepUpDenial(identity, "free_zone_tripped");
    return serveUnderKey(st, key, record, false, opts.context);
  }

  /* ---- inspection ---- */
  function keyInfo(tokenOrKid: string): BulkKeyInfo | undefined {
    if (typeof tokenOrKid !== "string") return undefined;
    const direct = keys.get(tokenOrKid);
    if (direct) return keyInfoOf(direct);
    if (tokenOrKid.includes(".")) {
      const payloadBytes = tryBase64UrlDecode(tokenOrKid.slice(0, tokenOrKid.indexOf(".")));
      if (!payloadBytes) return undefined;
      try {
        const parsed = JSON.parse(utf8Decode(payloadBytes)) as Partial<KeyPayload>;
        if (typeof parsed.kid === "string") {
          const stored = keys.get(parsed.kid);
          return stored ? keyInfoOf(stored) : undefined;
        }
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  function sliceForKey(kid: string): number[] | undefined {
    const key = keys.get(kid);
    return key ? [...key.slice] : undefined;
  }

  function markRecordsUnderKey(kid: string, records: ValueWatermarkRecord[]): ValueWatermarkMarkedRecord[] | undefined {
    const key = keys.get(kid);
    if (!key) return undefined;
    // C39 binding: the edition id is derived from the key's slice
    // commitment, so a republished edition attributes to this key.
    return watermark.markEdition(`gatekey:${key.cm}`, records);
  }

  function stats(): BulkAccessKeyStats {
    refreshPool(now());
    return {
      poolUsedToday: poolUsed,
      anonPoolPerDay,
      pendingAnonRequests: queue.length,
      totalIssuedByChannel: { ...totalIssuedByChannel },
      anonAccounted: anonAccountedTotal,
      shareEvidence,
      forks: [...forks],
      mergedCohorts: [...mergedCohorts],
      stepUpDemands: [...stepUpDemands],
    };
  }

  return {
    requestKey,
    drainAnonPool,
    noteNonBulkSession(identity: string): void {
      identityState(identity).nonBulkDayBuckets.add(dayBucket(now()));
    },
    isEstablished(identity: string, opts?: BulkKeyRequestOptions): boolean {
      return isEstablished(identityState(identity), opts);
    },
    serve,
    presentKey,
    keyInfo,
    sliceForKey,
    markRecordsUnderKey,
    stats,
  };
}
