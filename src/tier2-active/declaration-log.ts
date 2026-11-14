/**
 * Declaration log - host-side, append-only evidence that a
 * preference declaration existed before a republished copy
 * appeared (RECOMB-10 PREF-PROOF, measured PASS-lab in cycle
 * C451, 2026-11-13).
 *
 * A preference declaration on its own is just a published string:
 * the robots.txt Content-Signal line, an RSL `License:` line, or
 * an aipref `Content-Usage` header. It lives on the HOST, never
 * inside the data, so a republished copy never carries it - and
 * when a copy surfaces, the host needs more than "we published
 * that once" to place the declaration BEFORE the copy. This log
 * is that evidence: every declaration the host serves is appended
 * with its timestamp, and each entry's hash chains to the
 * previous entry's hash, so a later edit, deletion or insertion
 * in the retained history breaks verification at that index.
 * A valid prefix remains a valid chain: detecting tail truncation
 * or wholesale replacement requires an independently anchored
 * entry count and head hash, outside this host-controlled log.
 *
 * THE PAIRING (why this module exists): the C39 value watermark
 * (`createValueWatermark`) proves a republished copy descends
 * from the host's values, and its provenance claim survives the
 * declaration being stripped from the copy - but the watermark
 * cannot say the copier ever faced a declaration. The log
 * supplies the other half: a verifiable, timestamped record that
 * the declaration was in force before the copy appeared
 * (`predates`). In the lab the pair held together exactly: the
 * watermark arm with declarations matched the watermark-only arm
 * on all 18 republication transforms (declarations never enter
 * the data, so they cannot weaken the watermark), and this log's
 * chain verified 200/200 entries.
 *
 * CHAIN STRUCTURE (mirrors the measured lab log): entry i is
 * { index, timestamp, form, declaration, prevHash, hash } with
 *   hash = sha256(canonical JSON of { index, timestamp, form,
 *          declaration, prevHash })
 * and the genesis entry's prevHash is the fixed constant
 * sha256("RECOMB-10-GENESIS") - the same genesis seed the lab
 * chain used (exported below as DECLARATION_LOG_GENESIS_SEED).
 * The lab hashed one declaration block per log; this module
 * hashes each entry's own form + declaration text instead, so
 * one log can carry all three declaration forms over time.
 * Canonical JSON here means JSON.stringify of an object literal
 * built in exactly the field order above - the same bytes on
 * every Node runtime. The lab's chaining idea is unchanged; the
 * per-entry payload hash is the SDK generalization of its
 * declHash.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT:
 * - It proves ordering and integrity INSIDE the log: entry
 *   order, chained hashes, and that the earliest declaration
 *   timestamp precedes a given moment (`predates`).
 * - It does NOT prove crawler compliance with the declaration,
 *   and it does NOT prove any legal recognition of the claim -
 *   the lab measured the technical half only (per the
 *   registration, roughly 0 crawler compliance with preference
 *   signals has been reported in the field).
 * - Timestamps are the HOST's clock readings, in milliseconds
 *   since the epoch. The chain makes post-hoc edits detectable;
 *   it cannot make a host's clock truthful. A host that
 *   backdates its own clock backdates its log - the evidence is
 *   exactly as strong as the host's record-keeping discipline,
 *   and an exported log gains strength only when it is anchored
 *   somewhere the host cannot rewrite (the export exists so the
 *   host can do exactly that).
 *
 * Cost is one sha256 per append and one per entry on verify;
 * declaration-side generation in the lab measured p99
 * ~0.0003-0.0005 ms per step on the lab VM. Pure computation on
 * node:crypto (a Node builtin - still zero runtime
 * dependencies). No I/O; persistence is the host's job (keep
 * the export, or re-import it and keep appending).
 * Retention is bounded by entry, text and serialized-size limits.
 * At capacity append refuses without evicting history; archive and
 * anchor the existing chain before starting another log.
 */

/* ------------------------------------------------------------------------ */
/* Minimal structural view of node:crypto (mirroring config-provenance).    */
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
  throw new Error("node:crypto is not available in this runtime; the declaration log requires Node.js");
}

function sha256Hex(text: string): string {
  return getNodeCrypto().createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The canonical declaration surfaces. `form` is a free-form
 * string (hosts may log other surfaces); these three values name
 * the forms the RECOMB-10 registration froze:
 * - "robots-content-signal": the Content-Signal line in robots.txt
 * - "rsl-license": the RSL `License:` line
 * - "aipref-content-usage": the aipref `Content-Usage` header
 */
export type DeclarationForm = "robots-content-signal" | "rsl-license" | "aipref-content-usage" | (string & {});

/** Genesis seed of the chain; the genesis prevHash is sha256 of this string. */
export const DECLARATION_LOG_GENESIS_SEED = "RECOMB-10-GENESIS";

let genesisPrevHashCache: string | null = null;

function genesisPrevHash(): string {
  if (genesisPrevHashCache === null) {
    genesisPrevHashCache = sha256Hex(DECLARATION_LOG_GENESIS_SEED);
  }
  return genesisPrevHashCache;
}

export interface DeclarationLogAppendInput {
  /** Declaration surface, e.g. "robots-content-signal" (see DeclarationForm). */
  form: DeclarationForm;
  /** The declaration text exactly as served (the line or header value). */
  declaration: string;
  /** Host clock reading, milliseconds since the epoch. */
  timestamp: number;
}

/** Host-controlled retention bounds. A full log refuses append; it never drops history. */
export interface DeclarationLogOptions {
  /** Maximum retained entries. Default: 100000. */
  maxEntries?: number;
  /** Maximum UTF-16 code units per declaration. Default: 65536. */
  maxDeclarationLength?: number;
  /** Maximum UTF-16 code units per form. Default: 256. */
  maxFormLength?: number;
  /** Maximum serialized JSON code units, checked before import parsing. Default: 33554432. */
  maxSerializedLength?: number;
}

export interface DeclarationLogEntry {
  index: number;
  timestamp: number;
  form: string;
  declaration: string;
  prevHash: string;
  hash: string;
}

export interface DeclarationLogVerification {
  ok: boolean;
  /** Entries verified intact before the first bad one (all of them when ok). */
  checked: number;
  /** Index of the first entry that fails verification, or null when ok. */
  firstBadIndex: number | null;
}

export interface DeclarationLog {
  /** Append one declaration; returns the stored entry (a frozen copy). */
  append(input: DeclarationLogAppendInput): DeclarationLogEntry;
  /** Frozen copies of all entries, in chain order. Mutating them cannot affect the log. */
  entries(): readonly DeclarationLogEntry[];
  /** Recompute the whole chain from the genesis constant and report the first break. */
  verify(): DeclarationLogVerification;
  /** True iff the earliest entry's timestamp is <= the given timestamp. False on an empty log. */
  predates(timestamp: number): boolean;
  /** Serialize the log (JSON) for anchoring or persistence. */
  export(): string;
}

/** Named error thrown when an imported declaration log is malformed or its chain is broken. */
export class DeclarationLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeclarationLogError";
  }
}

interface EntryCore {
  index: number;
  timestamp: number;
  form: string;
  declaration: string;
  prevHash: string;
}

function canonicalEntryJson(core: EntryCore): string {
  // Field order is part of the format: index, timestamp, form,
  // declaration, prevHash - built as one literal so the bytes are
  // identical on every runtime.
  return JSON.stringify({
    index: core.index,
    timestamp: core.timestamp,
    form: core.form,
    declaration: core.declaration,
    prevHash: core.prevHash,
  });
}

function hashEntry(core: EntryCore): string {
  return sha256Hex(canonicalEntryJson(core));
}

function verifyEntries(list: readonly DeclarationLogEntry[]): DeclarationLogVerification {
  let prevHash = genesisPrevHash();
  let checked = 0;
  for (const entry of list) {
    const core: EntryCore = {
      index: entry.index,
      timestamp: entry.timestamp,
      form: entry.form,
      declaration: entry.declaration,
      prevHash: entry.prevHash,
    };
    if (entry.index !== checked || entry.prevHash !== prevHash || hashEntry(core) !== entry.hash) {
      return { ok: false, checked, firstBadIndex: checked };
    }
    prevHash = entry.hash;
    checked++;
  }
  return { ok: true, checked, firstBadIndex: null };
}

function frozenCopy(entry: DeclarationLogEntry): DeclarationLogEntry {
  return Object.freeze({ ...entry });
}

interface LogLimits {
  maxEntries: number;
  maxDeclarationLength: number;
  maxFormLength: number;
  maxSerializedLength: number;
}

function limitsOf(options: DeclarationLogOptions): LogLimits {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("declarationLog: options must be an object");
  }
  const defaults: LogLimits = {
    maxEntries: 100000,
    maxDeclarationLength: 65536,
    maxFormLength: 256,
    maxSerializedLength: 33554432,
  };
  for (const key of Object.keys(defaults) as (keyof LogLimits)[]) {
    const value = options[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError("declarationLog: " + key + " must be a positive safe integer");
      defaults[key] = value;
    }
  }
  return defaults;
}

function buildLog(initial: readonly DeclarationLogEntry[], limits: LogLimits): DeclarationLog {
  const list: DeclarationLogEntry[] = initial.map((e) => ({ ...e }));
  const envelopeLength = JSON.stringify({ format: "antiRea-declaration-log", version: 1, entries: [] }).length;
  let serializedLength = envelopeLength + list.reduce((sum, e, i) => sum + JSON.stringify(e).length + (i > 0 ? 1 : 0), 0);
  if (serializedLength > limits.maxSerializedLength) throw new DeclarationLogError("declarationLog: serialized length limit is smaller than the log envelope");
  return {
    append(input: DeclarationLogAppendInput): DeclarationLogEntry {
      if (!input || typeof input !== "object") {
        throw new TypeError("declarationLog.append: input is required");
      }
      if (typeof input.form !== "string") {
        throw new TypeError("declarationLog.append: input.form must be a string");
      }
      if (typeof input.declaration !== "string") {
        throw new TypeError("declarationLog.append: input.declaration must be a string");
      }
      if (typeof input.timestamp !== "number" || !Number.isFinite(input.timestamp)) {
        throw new TypeError("declarationLog.append: input.timestamp must be a finite number (ms since epoch)");
      }
      if (list.length >= limits.maxEntries || input.form.length > limits.maxFormLength || input.declaration.length > limits.maxDeclarationLength) {
        throw new DeclarationLogError("declarationLog.append: retention limit exceeded; archive the log before continuing");
      }
      const prevHash = list.length > 0 ? (list[list.length - 1] as DeclarationLogEntry).hash : genesisPrevHash();
      const core: EntryCore = {
        index: list.length,
        timestamp: input.timestamp,
        form: input.form,
        declaration: input.declaration,
        prevHash,
      };
      const entry: DeclarationLogEntry = { ...core, hash: hashEntry(core) };
      const addedLength = JSON.stringify(entry).length + (list.length > 0 ? 1 : 0);
      if (serializedLength + addedLength > limits.maxSerializedLength) {
        throw new DeclarationLogError("declarationLog.append: serialized length limit exceeded; archive the log before continuing");
      }
      list.push(entry);
      serializedLength += addedLength;
      return frozenCopy(entry);
    },
    entries(): readonly DeclarationLogEntry[] {
      return Object.freeze(list.map(frozenCopy));
    },
    verify(): DeclarationLogVerification {
      return verifyEntries(list);
    },
    predates(timestamp: number): boolean {
      if (list.length === 0 || !Number.isFinite(timestamp)) return false;
      let earliest = Infinity;
      for (const entry of list) if (entry.timestamp < earliest) earliest = entry.timestamp;
      return earliest <= timestamp;
    },
    export(): string {
      return JSON.stringify({
        format: "antiRea-declaration-log",
        version: 1,
        entries: list.map((e) => ({ ...e })),
      });
    },
  };
}

export function createDeclarationLog(options: DeclarationLogOptions = {}): DeclarationLog {
  return buildLog([], limitsOf(options));
}

function isStoredEntry(value: unknown): value is DeclarationLogEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.index === "number" && Number.isSafeInteger(e.index) && e.index >= 0 &&
    typeof e.timestamp === "number" && Number.isFinite(e.timestamp) &&
    typeof e.form === "string" &&
    typeof e.declaration === "string" &&
    typeof e.prevHash === "string" &&
    typeof e.hash === "string"
  );
}

/**
 * Parse an exported log, re-verify the whole chain against the
 * genesis constant, and return a log that can keep appending.
 * Throws DeclarationLogError on malformed JSON, a wrong shape, or
 * any break in the chain - a tampered export never imports
 * silently.
 */
export function importDeclarationLog(json: string, options: DeclarationLogOptions = {}): DeclarationLog {
  if (typeof json !== "string") {
    throw new TypeError("importDeclarationLog: a JSON string is required");
  }
  const limits = limitsOf(options);
  if (json.length > limits.maxSerializedLength) throw new DeclarationLogError("importDeclarationLog: serialized length limit exceeded");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new DeclarationLogError("importDeclarationLog: input is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new DeclarationLogError("importDeclarationLog: export must be a JSON object");
  }
  const envelope = parsed as Record<string, unknown>;
  if (envelope.format !== "antiRea-declaration-log" || envelope.version !== 1) {
    throw new DeclarationLogError("importDeclarationLog: unsupported format or version");
  }
  const rawEntries = (parsed as Record<string, unknown>).entries;
  if (!Array.isArray(rawEntries)) {
    throw new DeclarationLogError("importDeclarationLog: export has no entries array");
  }
  if (rawEntries.length > limits.maxEntries) throw new DeclarationLogError("importDeclarationLog: entry limit exceeded");
  const entries: DeclarationLogEntry[] = [];
  for (const raw of rawEntries) {
    if (!isStoredEntry(raw)) {
      throw new DeclarationLogError("importDeclarationLog: an entry is malformed");
    }
    if (raw.form.length > limits.maxFormLength || raw.declaration.length > limits.maxDeclarationLength || !/^[0-9a-f]{64}$/.test(raw.prevHash) || !/^[0-9a-f]{64}$/.test(raw.hash)) {
      throw new DeclarationLogError("importDeclarationLog: an entry exceeds limits or has an invalid hash");
    }
    entries.push({
      index: raw.index,
      timestamp: raw.timestamp,
      form: raw.form,
      declaration: raw.declaration,
      prevHash: raw.prevHash,
      hash: raw.hash,
    });
  }
  const verification = verifyEntries(entries);
  if (!verification.ok) {
    throw new DeclarationLogError(
      "importDeclarationLog: hash chain is broken at entry index " + String(verification.firstBadIndex),
    );
  }
  return buildLog(entries, limits);
}
