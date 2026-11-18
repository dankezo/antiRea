/**
 * Per-deployment bait persona - V1 form only (MGH-01, antiRea 3.1.0).
 * OPT-IN, default OFF. A sibling of decoy-mirage.ts and canary-echo.ts
 * in the decoy family.
 *
 * WHAT IT IS. Each deployment serves a unique fabricated company and
 * persona with bait credentials derived from a per-deployment secret
 * via HMAC-SHA256(secret, fieldId), formatted to the bait formats of
 * the source mechanism. Because every credential is derived, a
 * presented bait credential attributes to its deployment with no
 * lookup table: verification is recomputation under that
 * deployment's secret (the canary-echo tripwire property). A
 * credential presented to a different deployment does not verify
 * there.
 *
 * WHY V1 ONLY. The original V0 generator (15 prefixes x 14 suffixes
 * = 210 company names, 3 Server headers, pure-random credentials
 * with no derivation secret) FAILS in the lab: 32 duplicate slugs
 * among 128 deployments and a searchable demo name ("Vertex Labs",
 * already present verbatim in a public file). V1 fixes both: the
 * display name gains a qualifier (24 qualifiers, 5,040 name
 * combinations) and the slug carries a 6-char base32 random tag
 * (slug space about 5.4e12), the Server header is drawn from a
 * 12-version x 4-distro matrix (48 combinations), and credentials
 * are HMAC-derived. V0 is not built here.
 *
 * MEASURED (MGH Step-0 lab, mgh-lab/RESULTS-MGH-STEP0.md, seed
 * family 203111xx, n = 128 deployments): 0 collisions in all 5
 * secret fields and in slugs; own-deployment verification 80/80;
 * cross-deployment verification 0/1200; 0 search hits for 1,024 V1
 * identity strings over the two public trees measured; 45 distinct
 * Server headers of the 48-cell matrix; persistence 8/8 x 3 reloads
 * byte-identical; rotation 8/8 differing in all 5 secret fields
 * and slug. The search-hit property is a lab measurement against
 * those trees, not a property this module can re-prove locally;
 * the suite encodes the locally testable properties (uniqueness,
 * determinism, persistence, rotation, verification).
 *
 * DETERMINISM AND PERSISTENCE. Every persona field, not only the
 * credentials, is derived from the deployment secret by HMAC, so a
 * deployment's persona is a pure function of its secret: restarts
 * regenerate the byte-identical persona with no state file, and
 * rotating the secret rotates every secret field and the slug.
 * The secret itself is server-side only and is never part of the
 * served persona.
 *
 * DEFAULT OFF. Nothing is served until the host constructs the
 * factory with `enabled: true` and a secret. A disabled factory
 * exposes no persona and verifies nothing.
 *
 * ADVISORY ONLY. A bait credential presentation is a correlation
 * signal, never proof of malice by itself and never a sole
 * blocking key or an exemption.
 *
 * Node.js builtins only (node:crypto HMAC and CSPRNG); zero
 * runtime dependencies.
 */

export type BaitSecret = string | Uint8Array;

/** The 5 secret credential fields, in lab order. */
export const BAIT_CREDENTIAL_FIELDS = [
  "db_password",
  "aws_access_key_id",
  "aws_secret_access_key",
  "jwt_secret",
  "app_key",
] as const;

export type BaitCredentialField = (typeof BAIT_CREDENTIAL_FIELDS)[number];

export const BAIT_COMPANY_PREFIXES: readonly string[] = Object.freeze([
  "north", "blue", "summit", "harbor", "atlas", "vertex", "cedar", "granite",
  "silver", "pioneer", "beacon", "meridian", "keystone", "redwood", "crescent",
]);

export const BAIT_COMPANY_SUFFIXES: readonly string[] = Object.freeze([
  "logistics", "health", "capital", "systems", "retail", "labs", "analytics",
  "freight", "energy", "media", "insure", "foods", "supply", "travel",
]);

export const BAIT_COMPANY_QUALIFIERS: readonly string[] = Object.freeze([
  "group", "partners", "works", "collective", "union", "alliance",
  "ventures", "holdings", "network", "exchange", "society", "guild", "assembly",
  "consortium", "federation", "circle", "league", "forum", "bureau", "atelier",
  "studio", "depot", "yard", "house",
]);

export const BAIT_SERVER_VERSIONS: readonly string[] = Object.freeze([
  "1.18.0", "1.20.1", "1.20.2", "1.22.0", "1.22.1", "1.24.0",
  "1.25.1", "1.25.3", "1.26.0", "1.26.2", "1.27.0", "1.27.2",
]);

export const BAIT_SERVER_DISTROS: readonly string[] = Object.freeze([
  "(Ubuntu)", "(Debian)", "", "(CentOS)",
]);

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const REGIONS: readonly string[] = ["us-east-1", "us-east-2", "us-west-2", "eu-west-1"];
const DB_USERS: readonly string[] = ["app", "web", "portal", "api"];

export interface BaitPersona {
  company: string;
  slug: string;
  domain: string;
  apiVersion: string;
  serverHeader: string;
  dbHost: string;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  awsBucket: string;
  jwtSecret: string;
  appKey: string;
}

/* ------------------------------------------------------------------ */
/* node:crypto access, mirroring canary-echo.ts.                       */
/* ------------------------------------------------------------------ */

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
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:crypto is not available in this runtime; bait personas require Node.js");
}

const utf8Encode = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * A hex deployment secret (the lab form) is decoded to its bytes so
 * the HMAC key is the secret itself; any other string or byte secret
 * is used as-is.
 */
function secretKey(secret: BaitSecret): string | Uint8Array {
  if (typeof secret === "string" && /^[0-9a-fA-F]{64}$/.test(secret)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) bytes[i] = parseInt(secret.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  return secret;
}

/** HMAC-SHA256 expansion, lab form: block 0 is HMAC(msg), block n is HMAC(msg:n). */
function hmacBytes(secret: BaitSecret, msg: string, n: number): Uint8Array {
  const crypto = getNodeCrypto();
  const key = secretKey(secret);
  const out = new Uint8Array(n);
  let filled = 0;
  let block = 0;
  while (filled < n) {
    const digest = crypto.createHmac("sha256", key).update(block === 0 ? msg : `${msg}:${block}`).digest();
    const take = Math.min(digest.length, n - filled);
    out.set(digest.subarray(0, take), filled);
    filled += take;
    block++;
  }
  return out;
}

const mapBytes = (bytes: Uint8Array, alphabet: string): string => {
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return s;
};

const pickDerived = (secret: BaitSecret, label: string, list: readonly string[]): string => {
  const b = hmacBytes(secret, label, 2);
  const idx = ((b[0]! << 8) | b[1]!) % list.length;
  return list[idx] as string;
};

const title = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1);

/* ------------------------------------------------------------------ */
/* Credential derivation and verification.                             */
/* ------------------------------------------------------------------ */

type CredFormat = "hex64" | "urlsafe24" | "akia" | "b64_40" | "appkey";

const CRED_FORMATS: Record<BaitCredentialField, CredFormat> = {
  db_password: "urlsafe24",
  aws_access_key_id: "akia",
  aws_secret_access_key: "b64_40",
  jwt_secret: "hex64",
  app_key: "appkey",
};

/** Derive one bait credential field from the deployment secret. */
export function deriveBaitCredential(secret: BaitSecret, field: BaitCredentialField): string {
  const format = CRED_FORMATS[field];
  if (format === "hex64") {
    return Array.from(hmacBytes(secret, field, 32), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (format === "urlsafe24") {
    // Lab form: base64url of 24 HMAC bytes.
    let bin = "";
    for (const b of hmacBytes(secret, field, 24)) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  if (format === "akia") return "AKIA" + mapBytes(hmacBytes(secret, field, 16), B32);
  if (format === "b64_40") return mapBytes(hmacBytes(secret, field, 40), B64);
  return "base64:" + mapBytes(hmacBytes(secret, field, 43), B64) + "=";
}

/**
 * Verify a presented credential as this deployment's own: recompute
 * the derived value under this deployment's secret and compare in
 * constant time. No lookup table is involved; a credential derived
 * under another deployment's secret does not verify here.
 */
export function verifyBaitCredential(secret: BaitSecret, field: BaitCredentialField, presented: unknown): boolean {
  if (typeof presented !== "string" || presented.length === 0) return false;
  const expected = deriveBaitCredential(secret, field);
  if (presented.length !== expected.length) return false;
  try {
    return getNodeCrypto().timingSafeEqual(utf8Encode(presented), utf8Encode(expected));
  } catch {
    return presented === expected;
  }
}

/** Generate a fresh per-deployment secret (64 hex chars) from the CSPRNG. */
export function generateBaitDeploymentSecret(): string {
  const bytes = getNodeCrypto().randomBytes(32);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------ */
/* Persona generation.                                                 */
/* ------------------------------------------------------------------ */

/**
 * Generate the deployment's bait persona from its secret. Pure and
 * deterministic: the same secret always yields the byte-identical
 * persona (persistence across restarts with no state file), and a
 * different secret yields a different persona.
 */
export function generateBaitPersona(secret: BaitSecret): BaitPersona {
  const prefix = pickDerived(secret, "persona:prefix", BAIT_COMPANY_PREFIXES);
  const suffix = pickDerived(secret, "persona:suffix", BAIT_COMPANY_SUFFIXES);
  const qualifier = pickDerived(secret, "persona:qualifier", BAIT_COMPANY_QUALIFIERS);
  const tag = mapBytes(hmacBytes(secret, "persona:tag", 6), B32).toLowerCase();
  const slug = `${prefix}${suffix}${qualifier}-${tag}`;
  const version = pickDerived(secret, "persona:server-version", BAIT_SERVER_VERSIONS);
  const distro = pickDerived(secret, "persona:server-distro", BAIT_SERVER_DISTROS);
  const hostBytes = hmacBytes(secret, "persona:db-host", 3);
  const verBytes = hmacBytes(secret, "persona:api-version", 3);
  const bucketBytes = hmacBytes(secret, "persona:aws-bucket", 1);
  return {
    company: `${title(prefix)} ${title(suffix)} ${title(qualifier)}`,
    slug,
    domain: `${slug}.corp`,
    apiVersion: `${(verBytes[0]! % 3) + 1}.${verBytes[1]! % 10}.${verBytes[2]! % 20}`,
    serverHeader: distro ? `nginx/${version} ${distro}` : `nginx/${version}`,
    dbHost: `10.${(hostBytes[0]! % 254) + 1}.${(hostBytes[1]! % 254) + 1}.${(hostBytes[2]! % 254) + 1}`,
    dbName: `${prefix}_${suffix}_prod`,
    dbUser: `svc_${pickDerived(secret, "persona:db-user", DB_USERS)}`,
    dbPassword: deriveBaitCredential(secret, "db_password"),
    awsAccessKeyId: deriveBaitCredential(secret, "aws_access_key_id"),
    awsSecretAccessKey: deriveBaitCredential(secret, "aws_secret_access_key"),
    awsRegion: pickDerived(secret, "persona:aws-region", REGIONS),
    awsBucket: `${slug}-backups-${(bucketBytes[0]! % 90) + 10}`,
    jwtSecret: deriveBaitCredential(secret, "jwt_secret"),
    appKey: deriveBaitCredential(secret, "app_key"),
  };
}

/** Map a persona credential field name to its persona property value. */
export function baitPersonaCredential(persona: BaitPersona, field: BaitCredentialField): string {
  switch (field) {
    case "db_password": return persona.dbPassword;
    case "aws_access_key_id": return persona.awsAccessKeyId;
    case "aws_secret_access_key": return persona.awsSecretAccessKey;
    case "jwt_secret": return persona.jwtSecret;
    case "app_key": return persona.appKey;
  }
}

export interface BaitPersonaFactoryOptions {
  /** The pack serves only when this is exactly true. Default false (OFF). */
  enabled?: boolean;
  /** Per-deployment HMAC secret, server-side only. Required when enabled. */
  secret?: BaitSecret;
}

export class BaitPersonaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BaitPersonaError";
  }
}

export interface BaitPersonaFactory {
  readonly enabled: boolean;
  /** The deployment persona, or null when the factory is disabled. */
  readonly persona: BaitPersona | null;
  /** Verify a presented credential against this deployment. Always false when disabled. */
  verifyCredential: (field: BaitCredentialField, presented: unknown) => boolean;
}

/**
 * Create the opt-in bait-persona factory for one deployment.
 * Enabling without a secret throws, rather than serving bait that
 * attributes to nothing.
 */
export function createBaitPersona(options: BaitPersonaFactoryOptions = {}): BaitPersonaFactory {
  const enabled = options.enabled === true;
  if (!enabled) {
    return { enabled: false, persona: null, verifyCredential: () => false };
  }
  if (options.secret === undefined || (typeof options.secret === "string" && options.secret.length === 0)) {
    throw new BaitPersonaError(
      "createBaitPersona: secret is required when enabled - bait credentials must be " +
        "HMAC-derived from a per-deployment secret so a presented credential attributes " +
        "to its deployment with no lookup table",
    );
  }
  const secret = options.secret;
  const persona = generateBaitPersona(secret);
  return {
    enabled: true,
    persona,
    verifyCredential: (field, presented) => verifyBaitCredential(secret, field, presented),
  };
}
