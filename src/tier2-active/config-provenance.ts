/**
 * Config provenance pin (CS-02 ProvenancePin, lab pin
 * cs02-lab/REGISTRATION-CS-02-STEP0.md, results in
 * CS02-RESULTS.md).
 *
 * WHAT IT DOES. Every antiRea signal's verdict depends on its
 * effective configuration - the caller's options resolved under
 * the factory's declared defaults. Two hosts running "the same"
 * signal with different thresholds are running different
 * detectors, and an evidence pack that cannot say WHICH detector
 * produced it cannot be audited. This module pins a
 * configuration to a content hash:
 *
 *   hash = SHA-256(canonicalSerialize({ kind, version, options }))
 *
 * over the EFFECTIVE options (defaults resolved; only declared
 * fields enter - factories ignore unknown fields, so provenance
 * does too). The canonical serialization is frozen: object keys
 * sorted lexicographically at every level, -0 normalized to 0,
 * undefined object fields dropped, undefined array items become
 * null, and functions / symbols / bigints / NaN / Infinity are
 * unhashable and throw.
 *
 * WHAT THE LAB MEASURED (deterministic probe over the 43
 * declared options of the 7 signal kinds shipped in 2.7.4; no
 * traffic, no randomness): cross-process determinism 100%,
 * default-equivalence 100% (omitting an option hashes identically
 * to passing its default), mutation sensitivity 100% (every
 * declared option's mutation moves the hash), 0 collisions,
 * median overhead ~0.005 ms per instance against a 1 ms gate.
 *
 * USE. A factory (or the host) computes the pin once at
 * construction and attaches it to every evaluation / evidence
 * item (see createEvidentiaryRoles' decoration and the BS-01
 * verification fact, whose spec hook carries this hash). The pin
 * identifies a configuration; it is not a signature and proves
 * nothing about who computed it.
 *
 * Pure computation on node:crypto (a Node builtin - still zero
 * runtime dependencies). No I/O.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring web-bot-auth).         */
/* ------------------------------------------------------------------------ */

interface NodeHashLike {
  update(data: string, encoding: string): NodeHashLike;
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
  throw new Error("node:crypto is not available in this runtime; config provenance requires Node.js");
}

/** Named error thrown for unhashable config values. */
export class ConfigProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigProvenanceError";
  }
}

/**
 * Canonical serialization (frozen rules 1-5 of the CS-02
 * registration). Returns undefined for an undefined input - the
 * caller decides whether that means "drop the field" (objects)
 * or "null" (arrays). Throws ConfigProvenanceError on functions,
 * symbols, bigints, NaN and Infinity.
 */
export function canonicalSerializeConfig(value: unknown): string | undefined {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value as number)) {
      throw new ConfigProvenanceError(`canonicalSerializeConfig: unhashable number: ${value}`);
    }
    return JSON.stringify(value === 0 ? 0 : value); // -0 -> 0
  }
  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";
  if (t === "undefined") return undefined;
  if (t === "function" || t === "symbol" || t === "bigint") {
    throw new ConfigProvenanceError(`canonicalSerializeConfig: unhashable type: ${t}`);
  }
  if (Array.isArray(value)) {
    const parts = value.map((item) => {
      const s = canonicalSerializeConfig(item);
      return s === undefined ? "null" : s;
    });
    return "[" + parts.join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const k of keys) {
    const s = canonicalSerializeConfig(record[k]);
    if (s === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + s);
  }
  return "{" + parts.join(",") + "}";
}

/**
 * Resolve the effective config: for every field declared in
 * `defaults`, the caller's value when present (not undefined),
 * else the default. Undeclared caller fields never enter.
 */
export function resolveEffectiveConfig<T extends Record<string, unknown>>(
  defaults: T,
  callerOptions?: Record<string, unknown> | null,
): T {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(defaults)) {
    const v = callerOptions ? callerOptions[name] : undefined;
    out[name] = v === undefined ? defaults[name] : v;
  }
  return out as T;
}

/** SHA-256 hex over the canonical { kind, version, options }. */
export function configProvenanceHash(
  kind: string,
  version: string,
  resolvedOptions: Record<string, unknown>,
): string {
  const text = canonicalSerializeConfig({ kind, version, options: resolvedOptions });
  return getNodeCrypto().createHash("sha256").update(text as string, "utf8").digest("hex");
}

export interface ConfigProvenance {
  kind: string;
  version: string;
  /** The effective options the hash was computed over. */
  effectiveOptions: Record<string, unknown>;
  /** SHA-256 hex pin of { kind, version, effectiveOptions }. */
  hash: string;
}

/**
 * One-call pin: resolve `options` under `defaults` (when given)
 * and hash the result. Compute once at construction; attach the
 * hash to every output the configuration produces.
 */
export function createConfigProvenance(input: {
  kind: string;
  version: string;
  defaults?: Record<string, unknown>;
  options?: Record<string, unknown> | null;
}): ConfigProvenance {
  if (typeof input !== "object" || input === null) {
    throw new ConfigProvenanceError("createConfigProvenance: input must be an object");
  }
  if (typeof input.kind !== "string" || input.kind.length === 0) {
    throw new ConfigProvenanceError("createConfigProvenance: kind must be a non-empty string");
  }
  if (typeof input.version !== "string" || input.version.length === 0) {
    throw new ConfigProvenanceError("createConfigProvenance: version must be a non-empty string");
  }
  const effectiveOptions = input.defaults
    ? resolveEffectiveConfig(input.defaults, input.options ?? undefined)
    : { ...(input.options ?? {}) };
  return {
    kind: input.kind,
    version: input.version,
    effectiveOptions,
    hash: configProvenanceHash(input.kind, input.version, effectiveOptions),
  };
}
