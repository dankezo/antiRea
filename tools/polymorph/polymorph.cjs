'use strict';
/*
 * antiRea polymorph generator (3.2.0, build-time tool, opt-in).
 *
 * Generates a per-host variant of the SDK's built dist:
 *  - A1: the four attacker-facing surface modules (cursor,
 *    canary-echo, fake-endpoints, trap-paths) are obfuscated with a
 *    seed derived from the host's secret seed, using
 *    javascript-obfuscator. That package is an OPTIONAL build-time
 *    tool only; the SDK runtime stays zero-dependency. If it is not
 *    installed, this tool stops with instructions instead of
 *    producing a half-transformed variant.
 *  - A2: surface-manifest.json carries the seed-derived canary trap
 *    paths for the chosen epoch plus the previous epoch's retired
 *    set, using exactly the derivation in
 *    src/tier2-active/polymorph-surface.ts (the test suite checks
 *    the two implementations agree).
 *  - A4: the host fingerprint (SHA-256 of the seed) is embedded in
 *    the variant as an inert marker module, split across eight
 *    shard constants and never exported or executed, so a leaked
 *    variant can be traced to its host with
 *    tools/polymorph/extract-fingerprint.cjs. The marker file says
 *    what it is in its header; the watermark is documented in the
 *    CHANGELOG, not hidden from operators.
 *  - A5: plausible decoy functions with ordinary business names are
 *    appended to the transformed modules and the marker module.
 *    They are never exported and never called; they exist so an
 *    automated reader mapping the surface meets believable dead
 *    ends instead of random junk tokens.
 *
 * Usage:
 *   node tools/polymorph/polymorph.cjs --seed <host-secret> \
 *     --dist <built-dist-dir> --out <variant-dir> [--epoch <n>] [--count <n>]
 *
 * The pure helpers (path derivation, fingerprint, marker writer,
 * manifest builder) are exported for tests and do NOT require
 * javascript-obfuscator; only the obfuscation step loads it, lazily.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* Pure helpers (no optional dependencies below this line until CLI).  */
/* ------------------------------------------------------------------ */

function hashSeed(seedStr) { return crypto.createHash('sha256').update(String(seedStr)).digest(); }

function rngFrom(seedStr, label) {
  let counter = 0; let buf = Buffer.alloc(0); let pos = 0;
  return function next() {
    if (pos + 4 > buf.length) {
      buf = crypto.createHash('sha256').update(Buffer.concat([hashSeed(seedStr), Buffer.from(label + ':' + counter++)])).digest();
      pos = 0;
    }
    const v = buf.readUInt32BE(pos); pos += 4; return v / 0x100000000;
  };
}

const AREAS = ['internal', 'platform', 'system', 'core', 'ops', 'admin', 'partner', 'account', 'service', 'data'];
const OBJECTS = ['schema', 'prompt', 'feature', 'billing', 'catalog', 'user', 'report', 'config', 'token', 'sync', 'export', 'registry', 'session', 'audit', 'metric', 'policy'];
const ACTIONS = ['export', 'registry', 'dump', 'override', 'snapshot', 'listing', 'manifest', 'bundle', 'archive', 'review'];

function genCanaryPaths(seedStr, epoch, count = 4) {
  const rnd = rngFrom(seedStr, 'canary-paths:' + epoch);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const out = new Set();
  while (out.size < count) {
    const ver = 1 + Math.floor(rnd() * 3);
    out.add(`/api/v${ver}/${pick(AREAS)}/${pick(OBJECTS)}-${pick(ACTIONS)}`);
  }
  return [...out];
}

function epochOf(date = new Date()) { return Math.floor(date.getTime() / (7 * 24 * 3600 * 1000)); }

/** Full SHA-256 hex of the seed - the value embedded in the marker. */
function hostFingerprint(seedStr) { return crypto.createHash('sha256').update(String(seedStr)).digest('hex'); }

/** Short fingerprint used in manifests and reports (first 12 hex chars). */
function hostFingerprintShort(seedStr) { return hostFingerprint(seedStr).slice(0, 12); }

const SURFACE_MODULES = [
  'tier2-active/cursor.js',
  'tier2-active/canary-echo.js',
  'tier2-active/fake-endpoints.js',
  'tier2-active/trap-paths.js',
];

/* ------------------------------------------------------------------ */
/* A5 - decoy functions: plausible business logic, never called.       */
/* ------------------------------------------------------------------ */

const DECOY_FUNCTIONS = [
  {
    name: 'computeInvoiceTaxRateBps',
    body: `function __decoy_computeInvoiceTaxRateBps(regionCode, subtotalCents) {
  var base = regionCode === 'EU' ? 2100 : regionCode === 'APAC' ? 1000 : 825;
  if (subtotalCents > 500000) base -= 25;
  return Math.max(0, base + __DECOY_SALT__);
}`,
  },
  {
    name: 'normalizeShippingWindowLabel',
    body: `function __decoy_normalizeShippingWindowLabel(windowHours) {
  if (windowHours <= 24) return 'next-day';
  if (windowHours <= 72) return 'standard';
  return windowHours <= 168 ? 'economy' : 'freight';
}`,
  },
  {
    name: 'resolveCouponEligibilityTier',
    body: `function __decoy_resolveCouponEligibilityTier(cartTotalCents, loyaltyYears) {
  if (cartTotalCents >= 20000 && loyaltyYears >= 2) return 'gold';
  if (cartTotalCents >= 7500) return 'silver';
  return loyaltyYears >= 1 ? 'bronze' : 'none';
}`,
  },
  {
    name: 'estimateWarehouseLeadDays',
    body: `function __decoy_estimateWarehouseLeadDays(skuClass, distanceKm) {
  var base = skuClass === 'oversize' ? 5 : skuClass === 'hazard' ? 7 : 2;
  return base + Math.ceil(distanceKm / 900) + (__DECOY_SALT__ % 2);
}`,
  },
  {
    name: 'prorateSubscriptionRefundCents',
    body: `function __decoy_prorateSubscriptionRefundCents(monthlyCents, daysUsed, cycleDays) {
  if (cycleDays <= 0) return 0;
  var remaining = Math.max(0, cycleDays - daysUsed);
  return Math.floor((monthlyCents * remaining) / cycleDays);
}`,
  },
  {
    name: 'classifySupportPriority',
    body: `function __decoy_classifySupportPriority(score, slaTier) {
  var weight = slaTier === 'enterprise' ? 30 : slaTier === 'pro' ? 15 : 5;
  var total = score + weight + (__DECOY_SALT__ % 3);
  return total >= 80 ? 'urgent' : total >= 50 ? 'high' : total >= 25 ? 'normal' : 'low';
}`,
  },
  {
    name: 'computeBundleDiscountBps',
    body: `function __decoy_computeBundleDiscountBps(itemCount, subtotalCents) {
  if (itemCount < 3 || subtotalCents < 15000) return 0;
  return Math.min(1800, 300 + itemCount * 120);
}`,
  },
  {
    name: 'formatLoyaltyTierLabel',
    body: `function __decoy_formatLoyaltyTierLabel(points) {
  if (points >= 10000) return 'Platinum Member';
  if (points >= 4000) return 'Gold Member';
  if (points >= 1200) return 'Silver Member';
  return 'Member';
}`,
  },
];

/** Pick a deterministic subset of decoys for one seed and render them as inert source. */
function renderDecoyBlock(seedStr, saltLabel, count = 3) {
  const rnd = rngFrom(seedStr, 'decoys:' + saltLabel);
  const salt = Math.floor(rnd() * 7);
  const idx = new Set();
  while (idx.size < Math.min(count, DECOY_FUNCTIONS.length)) idx.add(Math.floor(rnd() * DECOY_FUNCTIONS.length));
  const parts = [...idx].map((i) => DECOY_FUNCTIONS[i].body.split('__DECOY_SALT__').join(String(salt)));
  return '\n/* Inert decoy logic (antiRea polymorph A5): never exported, never called. */\n' + parts.join('\n') + '\n';
}

function decoyNamesFor(seedStr, saltLabel, count = 3) {
  const rnd = rngFrom(seedStr, 'decoys:' + saltLabel);
  rnd(); // consume the salt draw so the selection stream matches renderDecoyBlock exactly
  const idx = new Set();
  while (idx.size < Math.min(count, DECOY_FUNCTIONS.length)) idx.add(Math.floor(rnd() * DECOY_FUNCTIONS.length));
  return [...idx].map((i) => DECOY_FUNCTIONS[i].name);
}

/* ------------------------------------------------------------------ */
/* A4 - variant marker module (inert fingerprint shards).              */
/* ------------------------------------------------------------------ */

const MARKER_REL_PATH = 'tier2-active/variant-marker.js';

function buildMarkerModule(fingerprint, seedStr) {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('fingerprint must be 64 hex chars');
  const shards = [];
  for (let i = 0; i < 8; i++) shards.push(fingerprint.slice(i * 8, i * 8 + 8));
  const lines = shards.map((s, i) => `const __variantShard${i} = "${s}";`).join('\n');
  return [
    '"use strict";',
    '/*',
    ' * antiRea variant marker (build watermark, A4 traitor tracing).',
    ' *',
    ' * This module is inert: it is not imported by the SDK index,',
    ' * exports nothing and runs nothing. It embeds the host',
    ' * fingerprint of the polymorph variant it shipped with, split',
    ' * across the shard constants below, so a leaked copy of the',
    ' * variant can be traced to its host with',
    ' * tools/polymorph/extract-fingerprint.cjs. The fingerprint is',
    ' * the SHA-256 of the host seed - it identifies the host without',
    ' * revealing the seed. Documented in the 3.2.0 CHANGELOG entry.',
    ' */',
    '/* VARIANT-MARKER-BEGIN */',
    lines,
    '/* VARIANT-MARKER-END */',
    renderDecoyBlock(seedStr, 'marker', 3),
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* Manifest.                                                           */
/* ------------------------------------------------------------------ */

function buildManifest({ seedStr, epoch, count = 4, moduleHashes, sdkVersion = null, decoys = [] }) {
  return {
    tool: 'antirea-polymorph',
    manifestVersion: 1,
    sdkVersion,
    hostFingerprint: hostFingerprintShort(seedStr),
    epoch,
    canaryPaths: genCanaryPaths(seedStr, epoch, count),
    retiredTrapPaths: genCanaryPaths(seedStr, epoch - 1, count),
    marker: MARKER_REL_PATH,
    decoys,
    moduleHashes,
  };
}

/* ------------------------------------------------------------------ */
/* Obfuscation (lazy optional dependency) + CLI.                       */
/* ------------------------------------------------------------------ */

function loadObfuscator() {
  try { return require('javascript-obfuscator'); } catch { /* try env override */ }
  const override = process.env.POLYMORPH_OBFUSCATOR_PATH;
  if (override) {
    try { return require(path.resolve(override)); } catch { /* fall through */ }
  }
  throw new Error(
    'javascript-obfuscator is not available. It is an optional build-time tool for the polymorph generator only ' +
    '(the SDK runtime stays zero-dependency). Install it where you run this tool (npm install --no-save javascript-obfuscator) ' +
    'or set POLYMORPH_OBFUSCATOR_PATH to an existing installation.'
  );
}

function obfuscateModule(JavaScriptObfuscator, code, seedInt) {
  return JavaScriptObfuscator.obfuscate(code, {
    seed: seedInt, compact: true, target: 'node',
    controlFlowFlattening: true, controlFlowFlatteningThreshold: 0.5,
    deadCodeInjection: true, deadCodeInjectionThreshold: 0.3,
    identifierNamesGenerator: 'hexadecimal', renameGlobals: false,
    stringArray: true, stringArrayEncoding: ['base64'], stringArrayThreshold: 0.75,
    selfDefending: false, disableConsoleOutput: false,
  }).getObfuscatedCode();
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { args[a.slice(2)] = argv[i + 1]; i++; }
  }
  return args;
}

function main(argv) {
  const args = parseArgs(argv);
  const seed = args.seed;
  const distDir = args.dist;
  const outDir = args.out;
  if (!seed || !distDir || !outDir) {
    console.error('usage: polymorph.cjs --seed <host-secret> --dist <dist-dir> --out <variant-dir> [--epoch <n>] [--count <n>]');
    process.exit(2);
  }
  if (!fs.existsSync(path.join(distDir, 'index.js'))) {
    console.error('dist dir does not contain index.js: ' + distDir);
    process.exit(2);
  }
  const epoch = args.epoch !== undefined ? parseInt(args.epoch, 10) : epochOf();
  const count = args.count !== undefined ? parseInt(args.count, 10) : 4;
  const JavaScriptObfuscator = loadObfuscator();
  const seedInt = hashSeed(seed).readUInt32BE(0);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.cpSync(distDir, outDir, { recursive: true });

  const moduleHashes = {};
  const decoyNames = new Set();
  for (const rel of SURFACE_MODULES) {
    const p = path.join(outDir, rel);
    if (!fs.existsSync(p)) continue;
    const obf = obfuscateModule(JavaScriptObfuscator, fs.readFileSync(p, 'utf8'), seedInt);
    const label = rel.replace(/[^a-z0-9]+/gi, '-');
    for (const n of decoyNamesFor(seed, label, 3)) decoyNames.add(n);
    fs.writeFileSync(p, obf + renderDecoyBlock(seed, label, 3));
    moduleHashes[rel] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }

  const markerPath = path.join(outDir, MARKER_REL_PATH);
  fs.writeFileSync(markerPath, buildMarkerModule(hostFingerprint(seed), seed));
  for (const n of decoyNamesFor(seed, 'marker', 3)) decoyNames.add(n);

  let sdkVersion = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(distDir, '..', 'package.json'), 'utf8'));
    if (pkg && typeof pkg.version === 'string') sdkVersion = pkg.version;
  } catch { /* manifest records null */ }

  const manifest = buildManifest({
    seedStr: seed, epoch, count, moduleHashes, sdkVersion, decoys: [...decoyNames],
  });
  fs.writeFileSync(path.join(outDir, 'surface-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ out: outDir, hostFingerprint: manifest.hostFingerprint, epoch, modules: Object.keys(moduleHashes), canaryPaths: manifest.canaryPaths }, null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(2);
  }
}

module.exports = {
  rngFrom, genCanaryPaths, epochOf,
  hostFingerprint, hostFingerprintShort,
  buildMarkerModule, buildManifest, renderDecoyBlock, decoyNamesFor,
  SURFACE_MODULES, MARKER_REL_PATH, DECOY_FUNCTIONS,
};
