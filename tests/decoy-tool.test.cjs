'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sdk = require('../dist/index.js');
const tool = require('../tools/decoy/decoy.cjs');
const { REGISTRY } = require('./fixtures/decoy-registry.cjs');

test('tool renders are byte-identical to the runtime renders (DEC-3 parity)', () => {
  const toolSurface = tool.generateSurface(REGISTRY);
  const sdkSurface = sdk.generateDecoySurface(REGISTRY);
  assert.equal(tool.renderRobots(toolSurface), sdk.renderDecoyRobots(sdkSurface));
  assert.equal(tool.renderSitemap(toolSurface), sdk.renderDecoySitemap(sdkSurface));
  assert.deepEqual(tool.buildSpec(toolSurface), sdk.buildDecoyOpenApiSpec(sdkSurface));
  assert.equal(tool.sequentialStepsTotal(1000000, [15, 5]), 807500);
});

test('tool invariant planting matches the runtime planting exactly', () => {
  const opts = { seed: 'parity', count: 6, groupPrefix: 'ORD' };
  assert.deepEqual(tool.plantInvariantViolations(opts), sdk.plantInvariantViolations(opts));
});

test('CLI writes the four artifacts and plants invariants when directed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antirea-decoy-tool-'));
  const registryPath = path.join(dir, 'registry.json');
  const outDir = path.join(dir, 'out');
  const registry = JSON.parse(JSON.stringify(REGISTRY));
  registry.plantInvariants = { seed: 'cli-test', count: 4, groupPrefix: 'WH' };
  fs.writeFileSync(registryPath, JSON.stringify(registry));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'decoy', 'decoy.cjs'), '--registry', registryPath, '--out', outDir], { stdio: 'pipe' });
  for (const f of ['robots-decoy.txt', 'sitemap-decoy.xml', 'openapi-decoy.json', 'decoy-bundle.json']) {
    assert.ok(fs.existsSync(path.join(outDir, f)), f);
  }
  const spec = JSON.parse(fs.readFileSync(path.join(outDir, 'openapi-decoy.json'), 'utf8'));
  assert.equal(spec.info.title, 'Catalog API');
  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, 'decoy-bundle.json'), 'utf8'));
  assert.equal(bundle.invariantSets.length, 4);
  assert.deepEqual(bundle.invariantSets, sdk.plantInvariantViolations({ seed: 'cli-test', count: 4, groupPrefix: 'WH' }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CLI refuses a registry with the wrong formatVersion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antirea-decoy-tool-'));
  const registryPath = path.join(dir, 'registry.json');
  fs.writeFileSync(registryPath, JSON.stringify({ formatVersion: 2 }));
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'decoy', 'decoy.cjs'), '--registry', registryPath, '--out', path.join(dir, 'out')], { stdio: 'pipe' }));
  fs.rmSync(dir, { recursive: true, force: true });
});
