/**
 * Honeymap (antiRea 3.3.3, X33-01) - OPT-IN, default OFF.
 *
 * WHAT IT DOES. A bundled script carries a sourceMappingURL whose
 * query token is keyed to the requesting identity. A clean identity
 * gets the "c" (clean) token and, when it fetches the map, receives
 * the host's REAL source map byte-identically. A flagged identity
 * gets the "f" (flagged) token and receives the DECOY map: a fake
 * module graph (decoy routes, decoy fields) in place of the real
 * one. The map fetch is itself the trace event: a consumer that
 * follows the flagged token has revealed that it reads source maps,
 * and the map it carries away describes a surface that does not
 * exist. Ported faithfully from the headline twin
 * (twin-server-x33-headline.cjs: bundleJs token, /app.js.map
 * handler, honeyMap / realMap bodies are host data here).
 *
 * MEASURED BASIS. X33-01 passed Wave 1, and in the composed
 * REALTEST-333-HEADLINE trial (2026-11-24) the composite of
 * X33-01 + X33-06 + X33-11 + X33-12 drove REA-default
 * task-success from 100% to 0% on both lab twins, with the
 * dataset the extractor carried away 100% poisoned and real-user
 * false positives at 0. All agent numbers in this program are
 * lab numbers on free models; no paid frontier agent was measured.
 *
 * CLAIM DISCIPLINE (freeze SCOPE-333-FREEZE-2026-11-25.md
 * section 2.2). This module poisons the map a flagged consumer
 * reads. It does not stop extraction, it does not prevent any
 * record from being taken through other routes, and no cost
 * claim is made for it: the composite cost gate FAILED in the
 * headline trial (1.32x catalog / 2.20x SPA against a 3.0x gate).
 *
 * CONTRACT.
 * - Disabled (no `enabled: true`), `tokenFor` always returns the
 *   clean variant and `mapFor` always serves the real map, so a
 *   host that enables nothing behaves byte-identically to 3.3.2.
 * - Clean token: the EXACT string from `realMaps` is returned,
 *   never re-serialized. Clean identities receive byte-identical
 *   output with the module ON vs OFF; this is a hard invariant.
 * - A token with a bad signature or an unknown variant serves
 *   the REAL map (the trial default): a forged token proves
 *   nothing and earns nothing.
 * - Unknown script: `handled: false`, the host's routing
 *   continues.
 * - Decoy serves fire `onLog`; a throwing sink never breaks
 *   serving.
 * - Composed mode (X33-12 channel): when `factLine` and
 *   `factSourceIndex` are set, the fact line is appended to that
 *   source's sourcesContent in the DECOY map only. The real map
 *   is never touched.
 */

interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(encoding: string): string;
}

interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
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
  throw new Error("node:crypto is not available in this runtime; honeymap requires Node.js");
}

export interface HoneymapLogEntry {
  source: "honeymap";
  script: string;
  variant: "decoy";
}

export interface HoneymapOptions {
  /** The module acts only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /** HMAC key for the variant tokens. Required when enabled. */
  secret?: string;
  /** Flagging seam: return true for identities that receive the decoy surface. Default: nobody is flagged. */
  isFlagged?: (identity: string) => boolean;
  /** Real source maps by script name, as exact strings. Served byte-identically to clean tokens. */
  realMaps: Record<string, string>;
  /** Decoy source maps by script name, as exact strings. Served to flagged tokens only. */
  decoyMaps: Record<string, string>;
  /** Composed-mode fact line (X33-12 channel), appended inside the decoy map only. */
  factLine?: string;
  /** Index into the decoy map's sourcesContent that receives `factLine`. */
  factSourceIndex?: number;
  /** Sink for decoy serve events. A throwing sink never breaks serving. */
  onLog?: (entry: HoneymapLogEntry) => void;
}

export interface HoneymapResult {
  handled: boolean;
  body?: string;
  variant?: "real" | "decoy";
}

export interface Honeymap {
  readonly enabled: boolean;
  /** Variant token for the script's sourceMappingURL query (?s=). */
  tokenFor: (script: string, identity: string) => string;
  /** Resolve a map fetch: which body, if any, this module serves. */
  mapFor: (script: string, token: string) => HoneymapResult;
}

export class HoneymapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoneymapError";
  }
}

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Create the honeymap module. See the module header for the full contract. */
export function createHoneymap(opts: HoneymapOptions): Honeymap {
  const enabled = opts.enabled === true;
  if (enabled && (opts.secret === undefined || opts.secret === "")) {
    throw new HoneymapError("createHoneymap: secret is required when enabled (variant tokens are keyed)");
  }
  const secret = opts.secret ?? "";
  const isFlagged = opts.isFlagged ?? (() => false);

  const signatureFor = (script: string, variant: string): string =>
    getNodeCrypto().createHmac("sha256", secret).update(`${script}:${variant}`).digest("hex").slice(0, 24);

  const tokenFor = (script: string, identity: string): string => {
    const variant = enabled && isFlagged(identity) ? "f" : "c";
    return `${variant}.${signatureFor(script, variant)}`;
  };

  const signatureValid = (script: string, variant: string, presented: string): boolean => {
    const expected = signatureFor(script, variant);
    if (presented.length !== expected.length) return false;
    try {
      return getNodeCrypto().timingSafeEqual(utf8Encode(presented), utf8Encode(expected));
    } catch {
      return false;
    }
  };

  const mapFor = (script: string, token: string): HoneymapResult => {
    // Own-property lookup only: a script name colliding with an
    // Object.prototype member ("toString", "constructor",
    // "__proto__") is an unknown script, not a hit.
    const real = Object.prototype.hasOwnProperty.call(opts.realMaps, script) ? opts.realMaps[script] : undefined;
    if (real === undefined) return { handled: false };
    if (!enabled) return { handled: true, body: real, variant: "real" };
    const dot = typeof token === "string" ? token.indexOf(".") : -1;
    const variant = dot > 0 ? token.slice(0, dot) : "";
    const presented = dot > 0 ? token.slice(dot + 1) : "";
    // Trial default: bad signature or unknown variant serves the REAL map.
    if ((variant !== "f" && variant !== "c") || !signatureValid(script, variant, presented)) {
      return { handled: true, body: real, variant: "real" };
    }
    if (variant === "c") return { handled: true, body: real, variant: "real" };
    const decoy = Object.prototype.hasOwnProperty.call(opts.decoyMaps, script) ? opts.decoyMaps[script] : undefined;
    if (decoy === undefined) return { handled: true, body: real, variant: "real" };
    let body = decoy;
    if (opts.factLine !== undefined && opts.factSourceIndex !== undefined) {
      try {
        const parsed = JSON.parse(decoy) as { sourcesContent?: unknown };
        if (Array.isArray(parsed.sourcesContent)) {
          const idx = opts.factSourceIndex;
          const current = parsed.sourcesContent[idx];
          if (typeof current === "string") {
            parsed.sourcesContent[idx] = `${current}\n${opts.factLine}`;
            body = JSON.stringify(parsed);
          }
        }
      } catch {
        /* an unparseable decoy map is served exactly as declared */
      }
    }
    try {
      opts.onLog?.({ source: "honeymap", script, variant: "decoy" });
    } catch {
      /* monitoring must never break serving */
    }
    return { handled: true, body, variant: "decoy" };
  };

  return { enabled, tokenFor, mapFor };
}
