'use strict';
/*
 * antiRea decoy surface generator (3.3.0, build-time tool, opt-in).
 *
 * DEC-3 packaging: the decoy discovery pack (A1) and the spec
 * decoy (A2) ship as build-time tooling first, like the 3.2.0
 * polymorph generator - the host generates static artifacts from
 * its registry and serves or mounts them under its own control,
 * instead of adding runtime middleware it did not ask for.
 *
 * Given a host-written decoy registry (the format validated by
 * src/tier2-active/decoy-registry.ts) this tool writes:
 *   robots-decoy.txt    - the A1 robots block (Disallow + Sitemap)
 *   sitemap-decoy.xml   - the A1 sitemap (real paths + decoy paths)
 *   openapi-decoy.json  - the A2 OpenAPI decoy document (with the
 *                         A3 endorsements and A5 worked examples)
 *   decoy-bundle.json   - the normalized surface, plus planted
 *                         invariant sets when the registry carries
 *                         a `plantInvariants` directive (A6)
 *
 * The renders and the invariant planting are second
 * implementations of the runtime modules' pure functions
 * (decoy-registry.ts / decoy-invariants.ts); the test suite pins
 * the two implementations to identical outputs, so a host gets
 * the same artifacts whether it generates them at build time or
 * renders them at runtime with createDecoySurface.
 *
 * Usage:
 *   node tools/decoy/decoy.cjs --registry <registry.json> --out <dir>
 *
 * The pure helpers are exported for tests. No dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* Deterministic stream (SHA-256 chain - identical to the runtime).    */
/* ------------------------------------------------------------------ */

function sha256Bytes(data) { return crypto.createHash('sha256').update(data).digest(); }

function decoyRng(seed, label) {
  const seedHash = sha256Bytes(String(seed));
  let counter = 0; let buf = Buffer.alloc(0); let pos = 0;
  return function next() {
    if (pos + 4 > buf.length) {
      buf = sha256Bytes(Buffer.concat([seedHash, Buffer.from(`${label}:${counter++}`, 'utf8')]));
      pos = 0;
    }
    const v = buf.readUInt32BE(pos); pos += 4; return v / 0x100000000;
  };
}

/* ------------------------------------------------------------------ */
/* Surface normalization (mirrors generateDecoySurface).               */
/* ------------------------------------------------------------------ */

function generateSurface(registry) {
  if (!registry || typeof registry !== 'object') throw new Error('registry must be an object');
  if (registry.formatVersion !== 1) throw new Error('formatVersion must be 1');
  const endpoints = registry.endpoints || [];
  const seen = new Set();
  for (const ep of endpoints) {
    if (!ep || typeof ep.path !== 'string' || !ep.path.startsWith('/')) throw new Error(`endpoint path must be absolute: ${ep && ep.path}`);
    if (seen.has(ep.path)) throw new Error(`duplicate endpoint path: ${ep.path}`);
    seen.add(ep.path);
    if (ep.kind === 'live' && ep.payload === undefined) throw new Error(`live endpoint has no payload: ${ep.path}`);
    if (ep.kind === 'page' && typeof ep.html !== 'string') throw new Error(`page endpoint has no html: ${ep.path}`);
    if (ep.kind === 'phantom' && ep.payload !== undefined) throw new Error(`phantom endpoint carries a payload: ${ep.path}`);
  }
  return {
    endpoints,
    joinSets: registry.joinSets || [],
    expandables: registry.expandables || [],
    contradictions: registry.contradictions || [],
    workedExamples: registry.workedExamples || [],
    discovery: {
      disallowPaths: (registry.discovery && registry.discovery.disallowPaths) || [],
      sitemapPaths: (registry.discovery && registry.discovery.sitemapPaths) || [],
      sitemapRealPaths: (registry.discovery && registry.discovery.sitemapRealPaths) || [],
    },
    specPath: (registry.spec && registry.spec.specPath) || '/openapi.json',
    docsPath: (registry.spec && registry.spec.docsPath) || '/api-docs',
    specTitle: (registry.spec && registry.spec.title) || 'API',
    specVersion: (registry.spec && registry.spec.version) || '1.0.0',
    realPaths: (registry.spec && registry.spec.realPaths) || [],
  };
}

/* ------------------------------------------------------------------ */
/* Renders (mirror decoy-registry.ts byte for byte).                   */
/* ------------------------------------------------------------------ */

function renderRobots(surface) {
  const lines = ['User-agent: *', 'Allow: /'];
  for (const p of surface.discovery.disallowPaths) lines.push(`Disallow: ${p}`);
  lines.push('Sitemap: /sitemap.xml');
  return lines.join('\n') + '\n';
}

function renderSitemap(surface) {
  const paths = [...surface.discovery.sitemapRealPaths, ...surface.discovery.sitemapPaths];
  const urls = paths.map((p) => `<url><loc>${p}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

function sequentialStepsTotal(subtotal, stepsPct) {
  let total = subtotal;
  for (const pct of stepsPct) total *= 1 - pct / 100;
  return Math.round(total);
}

function buildSpec(surface) {
  const ok = { responses: { '200': { description: 'OK' } } };
  const paths = {};
  for (const p of surface.realPaths) paths[p] = { get: { summary: 'Real endpoint (mirrored path only)', ...ok } };
  for (const ep of surface.endpoints) {
    paths[ep.path] = { get: { summary: ep.summary !== undefined ? ep.summary : (ep.kind === 'phantom' ? 'Preview endpoint' : 'Decoy endpoint'), ...ok } };
  }
  for (const js of surface.joinSets) {
    paths[js.parentPath] = { get: { summary: 'Directory (decoy)', ...ok } };
    paths[js.childPath] = { get: { summary: 'Records referencing the directory by id (decoy)', ...ok } };
  }
  for (const c of surface.contradictions) {
    paths[c.feedPath] = { get: { summary: 'Partner feed', description: c.endorsement, ...ok } };
  }
  for (const w of surface.workedExamples) {
    paths[w.path] = {
      get: {
        summary: 'Worked calculation example',
        description: `Documented rule: apply the percentage steps sequentially - ${w.stepsPct.join('%, then ')}% - to the subtotal.`,
        ...ok,
      },
    };
  }
  for (const x of surface.expandables) {
    paths[`${x.path}?${x.param}=${x.value}`] = { get: { summary: `Expanded variant (${x.kind})`, ...ok } };
  }
  return { openapi: '3.0.3', info: { title: `${surface.specTitle} API`, version: surface.specVersion }, paths };
}

/* ------------------------------------------------------------------ */
/* A6 planting (mirrors decoy-invariants.ts exactly).                  */
/* ------------------------------------------------------------------ */

function plantInvariantViolations(opts) {
  const startAt = opts.startAt !== undefined ? opts.startAt : 9101;
  const minTotal = opts.minTotal !== undefined ? opts.minTotal : 500000;
  const maxTotal = opts.maxTotal !== undefined ? opts.maxTotal : 4000000;
  const [mmMin, mmMax] = opts.mismatchPctRange || [5, 12.5];
  const [pMin, pMax] = opts.partsRange || [2, 4];
  const rnd = decoyRng(opts.seed, `invariants:${opts.groupPrefix}`);
  const draw = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const sets = [];
  for (let s = 0; s < opts.count; s++) {
    const statedTotal = draw(minTotal, maxTotal);
    const sign = rnd() < 0.5 ? -1 : 1;
    const mismatchPct = sign * (mmMin + rnd() * (mmMax - mmMin));
    const partsSum = Math.max(pMax, Math.round(statedTotal * (1 + mismatchPct / 100)));
    const partCount = draw(pMin, pMax);
    const weights = [];
    let wTotal = 0;
    for (let k = 0; k < partCount; k++) { const w = 0.5 + rnd(); weights.push(w); wTotal += w; }
    const parts = [];
    let assigned = 0;
    for (let k = 0; k < partCount; k++) {
      const amount = k === partCount - 1 ? partsSum - assigned : Math.max(1, Math.floor((partsSum * weights[k]) / wTotal));
      assigned += amount;
      parts.push({ partId: `${opts.groupPrefix}-${startAt + s}-${k + 1}`, amount });
    }
    const actualSum = parts.reduce((acc, p) => acc + p.amount, 0);
    sets.push({
      group: `${opts.groupPrefix}-${startAt + s}`,
      statedTotal,
      parts,
      partsSum: actualSum,
      mismatchPct: ((actualSum - statedTotal) / statedTotal) * 100,
    });
  }
  return sets;
}

/* ------------------------------------------------------------------ */
/* CLI.                                                                */
/* ------------------------------------------------------------------ */

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
  if (!args.registry || !args.out) {
    console.error('usage: decoy.cjs --registry <registry.json> --out <dir>');
    process.exit(2);
  }
  const registry = JSON.parse(fs.readFileSync(args.registry, 'utf8'));
  const surface = generateSurface(registry);
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(path.join(args.out, 'robots-decoy.txt'), renderRobots(surface));
  fs.writeFileSync(path.join(args.out, 'sitemap-decoy.xml'), renderSitemap(surface));
  fs.writeFileSync(path.join(args.out, 'openapi-decoy.json'), JSON.stringify(buildSpec(surface), null, 2) + '\n');
  const bundle = { tool: 'antirea-decoy', bundleVersion: 1, surface };
  if (registry.plantInvariants) {
    bundle.invariantSets = plantInvariantViolations(registry.plantInvariants);
  }
  fs.writeFileSync(path.join(args.out, 'decoy-bundle.json'), JSON.stringify(bundle, null, 2) + '\n');
  console.log(JSON.stringify({
    out: args.out,
    endpoints: surface.endpoints.length,
    joinSets: surface.joinSets.length,
    expandables: surface.expandables.length,
    invariantSets: bundle.invariantSets ? bundle.invariantSets.length : 0,
  }, null, 2));
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(err && err.message ? err.message : String(err));
    process.exit(2);
  }
}

module.exports = {
  decoyRng, generateSurface, renderRobots, renderSitemap,
  sequentialStepsTotal, buildSpec, plantInvariantViolations,
};
