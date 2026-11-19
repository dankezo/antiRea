/**
 * Variant integrity manifest (3.2.0, opt-in, advisory only).
 *
 * A host that generates a per-host variant of the SDK's surface
 * modules (see `tools/polymorph/` and `polymorph-surface.ts`) gets a
 * manifest of SHA-256 hashes for the generated files. This module
 * builds such a manifest from in-memory file contents and verifies a
 * set of files against one.
 *
 * ADVISORY ONLY, BY CONTRACT. `verifyVariantManifest` NEVER throws
 * and never blocks anything: it returns a signal object
 * (`{ ok, mismatches }`) and the host decides what a mismatch means
 * (log it, alert on it, fold it into its evidence - the same posture
 * as a canary hit). A mismatch is not proof of tampering: bundlers,
 * transpilers, line-ending conversion and partial deploys all change
 * file bytes legitimately, which is exactly why this signal must
 * never gate the host's main flow. Files that cannot be read are
 * reported as mismatches with reason `missing` or `unreadable`,
 * never thrown. A malformed manifest is reported the same way, as a
 * single `<manifest>` mismatch with reason `invalid_manifest`.
 *
 * No I/O lives here: the host supplies file contents (build side)
 * and a reader callback (verify side), so the module stays usable
 * in tests, build scripts and runtimes alike. Hashing uses
 * node:crypto SHA-256; there are no new dependencies.
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
  throw new Error("node:crypto is not available in this runtime; variant integrity requires Node.js");
}

/** SHA-256 hex digest of a string (UTF-8) or byte array. */
export function hashVariantContent(content: string | Uint8Array): string {
  const hash = getNodeCrypto().createHash("sha256");
  if (typeof content === "string") hash.update(content, "utf8");
  else hash.update(content);
  return hash.digest("hex");
}

export interface VariantManifest {
  version: 1;
  algorithm: "sha256";
  /** Map of file path (as supplied by the host) to expected SHA-256 hex. */
  files: Record<string, string>;
}

/**
 * Build a manifest over in-memory file contents. Keys are used
 * verbatim as the manifest's paths - the host chooses the naming
 * (relative paths are recommended so the manifest stays portable).
 * This function may throw on unhashable input; verification below
 * is the side that never throws.
 */
export function buildVariantManifest(
  files: Record<string, string | Uint8Array>,
): VariantManifest {
  const out: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    out[filePath] = hashVariantContent(content);
  }
  return { version: 1, algorithm: "sha256", files: out };
}

export type VariantMismatchReason =
  | "hash_mismatch"
  | "missing"
  | "unreadable"
  | "invalid_manifest";

export interface VariantMismatch {
  path: string;
  reason: VariantMismatchReason;
  /** Expected SHA-256 hex from the manifest, when one was recorded. */
  expected?: string;
  /** Actual SHA-256 hex of the bytes read, when bytes were read. */
  actual?: string;
}

export interface VariantIntegritySignal {
  ok: boolean;
  /** Number of manifest entries checked. */
  checked: number;
  mismatches: VariantMismatch[];
}

/** Reader the host supplies to verification: return the file's bytes, or null/undefined when absent. */
export type VariantFileReader = (
  filePath: string,
) => string | Uint8Array | null | undefined;

/**
 * Verify files against a manifest. NEVER throws: read errors,
 * missing files, hash differences and even a malformed manifest
 * are all reported inside the returned signal.
 */
export function verifyVariantManifest(
  manifest: unknown,
  readFile: VariantFileReader,
): VariantIntegritySignal {
  const invalid = (detail: string): VariantIntegritySignal => ({
    ok: false,
    checked: 0,
    mismatches: [{ path: "<manifest>", reason: "invalid_manifest", actual: detail }],
  });
  try {
    if (manifest === null || typeof manifest !== "object") return invalid("manifest is not an object");
    const m = manifest as Partial<VariantManifest>;
    if (m.algorithm !== "sha256" || m.files === null || typeof m.files !== "object") {
      return invalid("manifest lacks a sha256 files map");
    }
    const entries = Object.entries(m.files as Record<string, unknown>);
    const mismatches: VariantMismatch[] = [];
    let checked = 0;
    for (const [filePath, expected] of entries) {
      checked += 1;
      if (typeof expected !== "string") {
        mismatches.push({ path: filePath, reason: "invalid_manifest" });
        continue;
      }
      let content: string | Uint8Array | null | undefined;
      try {
        content = readFile(filePath);
      } catch {
        mismatches.push({ path: filePath, reason: "unreadable", expected });
        continue;
      }
      if (content === null || content === undefined) {
        mismatches.push({ path: filePath, reason: "missing", expected });
        continue;
      }
      let actual: string;
      try {
        actual = hashVariantContent(content);
      } catch {
        mismatches.push({ path: filePath, reason: "unreadable", expected });
        continue;
      }
      if (actual !== expected) {
        mismatches.push({ path: filePath, reason: "hash_mismatch", expected, actual });
      }
    }
    return { ok: mismatches.length === 0, checked, mismatches };
  } catch {
    return invalid("verification failed unexpectedly");
  }
}
