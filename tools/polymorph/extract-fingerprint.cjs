'use strict';
/*
 * antiRea polymorph fingerprint extractor (3.2.0, A4 traitor tracing).
 *
 * Reads a variant directory produced by tools/polymorph/polymorph.cjs
 * (or a variant-marker.js file directly) and prints the host
 * fingerprint embedded in the marker module: the SHA-256 of the host
 * seed, split across eight inert shard constants at build time.
 * Knowing the fingerprint identifies which host a leaked variant
 * came from; it does not reveal the seed.
 *
 * Usage: node tools/polymorph/extract-fingerprint.cjs <variant-dir|marker-file>
 */
const fs = require('fs');
const path = require('path');

function extractFingerprint(markerText) {
  if (typeof markerText !== 'string') return null;
  const shards = new Map();
  const re = /__variantShard(\d+)\s*=\s*"([0-9a-f]{8})"/g;
  let m;
  while ((m = re.exec(markerText)) !== null) shards.set(parseInt(m[1], 10), m[2]);
  if (shards.size !== 8) return null;
  let out = '';
  for (let i = 0; i < 8; i++) {
    const part = shards.get(i);
    if (!part) return null;
    out += part;
  }
  return /^[0-9a-f]{64}$/.test(out) ? out : null;
}

function resolveMarkerPath(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  const inVariant = path.join(target, 'tier2-active', 'variant-marker.js');
  if (fs.existsSync(inVariant)) return inVariant;
  return null;
}

function main(argv) {
  const target = argv[0];
  if (!target) {
    console.error('usage: extract-fingerprint.cjs <variant-dir|marker-file>');
    process.exit(2);
  }
  const markerPath = resolveMarkerPath(target);
  if (!markerPath) {
    console.error('no variant marker found under: ' + target);
    process.exit(2);
  }
  const fingerprint = extractFingerprint(fs.readFileSync(markerPath, 'utf8'));
  if (!fingerprint) {
    console.error('marker found but fingerprint shards are incomplete: ' + markerPath);
    process.exit(2);
  }
  console.log(fingerprint);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { extractFingerprint, resolveMarkerPath };
