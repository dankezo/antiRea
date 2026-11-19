/**
 * Per-host polymorphic canary surface (3.2.0, opt-in).
 *
 * THE LEAK THIS FIXES. The shipped `CANARY_TRAP_PATHS` defaults in
 * `trap-paths.ts` are identical on every deployment: anyone who reads
 * the SDK once learns the exact four canary trap paths used by every
 * site running antiRea, and can avoid them forever. The fake-endpoint
 * paths (`FAKE_TRAP_PATHS`) do NOT have this problem and are NOT
 * derived here: they are the fixed scanner liturgy (/.env,
 * /wp-admin/, ...) that scanners probe verbatim, so they must stay
 * exactly as shipped.
 *
 * WHAT THIS MODULE DOES. It derives a host-specific set of
 * natural-looking canary trap paths from a host-chosen seed and a
 * weekly epoch, using only SHA-256 (node:crypto) - deterministic,
 * pure, zero new dependencies. The host passes the derived paths to
 * the canary machinery it already uses (for example
 * `CanaryOptions.paths`), replacing the shipped defaults, so one
 * deployment's trap surface teaches an attacker nothing about any
 * other deployment. Paths from the PREVIOUS epoch are returned as
 * `retiredTrapPaths`: the host keeps them registered as detectors
 * but no longer links or serves them as bait anywhere, so a hit on a
 * retired path means the caller is working from old or stolen intel.
 *
 * HONEST LIMITS. Derived paths are a moving target, not a secret:
 * a leaked variant or a leaked config reveals that epoch's paths,
 * which is exactly why the epoch rotates weekly. The derivation is
 * deterministic by design (the host must be able to re-derive its
 * own surface after a restart, and the build-time polymorph
 * generator in `tools/polymorph/` reproduces the same paths from
 * the same seed); anyone who learns the host's seed can derive the
 * surface, so the seed is a host secret and belongs with the host's
 * other secrets, never in client code. This module is advisory
 * plumbing only: it names trap surfaces, it does not detect, block
 * or ban anything by itself.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring config-provenance).    */
/* ------------------------------------------------------------------------ */

interface NodeHashLike {
  update(data: string | Uint8Array, encoding?: string): NodeHashLike;
  digest(encoding: string): string;
}

interface NodeCryptoLike {
  createHash(algorithm: string): NodeHashLike;
}

declare const require: ((id: string) => NodeCryptoLike) | undefined;

function getNodeCrypto(): NodeCryptoLike {
  if (typeof require === "function") {
    try {
      const nodeCrypto = require("node:crypto");
      if (nodeCrypto && typeof nodeCrypto.createHash === "function") return nodeCrypto;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; polymorph surface requires Node.js");
}

function sha256Bytes(data: string | Uint8Array): Uint8Array {
  const hex = getNodeCrypto().createHash("sha256").update(data as string, "utf8").digest("hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function sha256Hex(data: string): string {
  return getNodeCrypto().createHash("sha256").update(data, "utf8").digest("hex");
}

/* ------------------------------------------------------------------------ */
/* Deterministic stream (SHA-256 chain - identical to tools/polymorph).     */
/* ------------------------------------------------------------------------ */

function polymorphRng(seed: string, label: string): () => number {
  const seedHash = sha256Bytes(seed);
  let counter = 0;
  let buf: Uint8Array = new Uint8Array(0);
  let pos = 0;
  return () => {
    if (pos + 4 > buf.length) {
      const labelBytes = new TextEncoder().encode(`${label}:${counter}`);
      counter += 1;
      const block = new Uint8Array(seedHash.length + labelBytes.length);
      block.set(seedHash, 0);
      block.set(labelBytes, seedHash.length);
      buf = sha256Bytes(block);
      pos = 0;
    }
    const b0 = buf[pos] as number;
    const b1 = buf[pos + 1] as number;
    const b2 = buf[pos + 2] as number;
    const b3 = buf[pos + 3] as number;
    pos += 4;
    return (b0 * 0x1000000 + b1 * 0x10000 + b2 * 0x100 + b3) / 0x100000000;
  };
}

const POLYMORPH_AREAS: readonly string[] = [
  "internal", "platform", "system", "core", "ops",
  "admin", "partner", "account", "service", "data",
];

const POLYMORPH_OBJECTS: readonly string[] = [
  "schema", "prompt", "feature", "billing", "catalog", "user",
  "report", "config", "token", "sync", "export", "registry",
  "session", "audit", "metric", "policy",
];

const POLYMORPH_ACTIONS: readonly string[] = [
  "export", "registry", "dump", "override", "snapshot",
  "listing", "manifest", "bundle", "archive", "review",
];

/** Milliseconds in one polymorph epoch (one week). */
export const POLYMORPH_EPOCH_MS = 7 * 24 * 3600 * 1000;

/** Default number of derived canary paths (matches the shipped default count). */
export const DEFAULT_POLYMORPH_PATH_COUNT = 4;

/** The weekly epoch containing `now` (ms since the Unix epoch). */
export function polymorphEpochOf(now: number = Date.now()): number {
  return Math.floor(now / POLYMORPH_EPOCH_MS);
}

/**
 * Derive `count` canary trap paths for one (seed, epoch) pair.
 * Deterministic: the same inputs always produce the same paths, in
 * the same order; a different seed or epoch produces a different
 * set. Paths look like ordinary API routes:
 * `/api/v<1-3>/<area>/<object>-<action>`.
 */
export function derivePolymorphCanaryPaths(
  seed: string,
  epoch: number,
  count: number = DEFAULT_POLYMORPH_PATH_COUNT,
): string[] {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("derivePolymorphCanaryPaths requires a non-empty seed string");
  }
  if (!Number.isFinite(epoch)) throw new Error("derivePolymorphCanaryPaths requires a finite epoch");
  const wanted = Math.max(0, Math.floor(count));
  const rnd = polymorphRng(seed, `canary-paths:${Math.floor(epoch)}`);
  const pick = (arr: readonly string[]): string => {
    const item = arr[Math.floor(rnd() * arr.length)];
    if (item === undefined) throw new Error("polymorph wordlist is empty");
    return item;
  };
  const out = new Set<string>();
  while (out.size < wanted) {
    const ver = 1 + Math.floor(rnd() * 3);
    out.add(`/api/v${ver}/${pick(POLYMORPH_AREAS)}/${pick(POLYMORPH_OBJECTS)}-${pick(POLYMORPH_ACTIONS)}`);
  }
  return [...out];
}

export interface PolymorphSurface {
  epoch: number;
  /** Trap paths for the current epoch - serve/link these as bait. */
  canaryPaths: string[];
  /** Previous epoch's paths - detectors only; a hit means old or stolen intel. */
  retiredTrapPaths: string[];
}

/** Derive the full surface for one epoch: current paths plus the retired set. */
export function derivePolymorphSurface(
  seed: string,
  epoch: number = polymorphEpochOf(),
  count: number = DEFAULT_POLYMORPH_PATH_COUNT,
): PolymorphSurface {
  const e = Math.floor(epoch);
  return {
    epoch: e,
    canaryPaths: derivePolymorphCanaryPaths(seed, e, count),
    retiredTrapPaths: derivePolymorphCanaryPaths(seed, e - 1, count),
  };
}

/**
 * Short non-secret identifier for a seed (first 12 hex chars of its
 * SHA-256). The build-time polymorph generator embeds this
 * fingerprint in each variant for leak tracing; it identifies the
 * host without revealing the seed.
 */
export function polymorphHostFingerprint(seed: string): string {
  if (typeof seed !== "string" || seed.length === 0) {
    throw new Error("polymorphHostFingerprint requires a non-empty seed string");
  }
  return sha256Hex(seed).slice(0, 12);
}
