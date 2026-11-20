'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sdk = require('../dist/index.js');
const tool = require('../tools/decoy/decoy.cjs');
const { REGISTRY_331 } = require('./fixtures/decoy-registry-331.cjs');

test('3.3.1 tool renders stay byte-identical to the runtime renders (DEC-3 parity, chains + GraphQL)', () => {
  const toolSurface = tool.generateSurface(REGISTRY_331);
  const sdkSurface = sdk.generateDecoySurface(REGISTRY_331);
  assert.equal(tool.renderRobots(toolSurface), sdk.renderDecoyRobots(sdkSurface));
  assert.equal(tool.renderSitemap(toolSurface), sdk.renderDecoySitemap(sdkSurface));
  assert.deepEqual(tool.buildSpec(toolSurface), sdk.buildDecoyOpenApiSpec(sdkSurface));
  assert.equal(tool.renderGraphqlSdl(REGISTRY_331.graphql), sdk.renderGraphqlSdl(REGISTRY_331.graphql));
});

test('CLI bundle carries the 3.3.1 families and the spec carries chain routes plus the SDL extension', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antirea-decoy-tool-331-'));
  const registryPath = path.join(dir, 'registry.json');
  const outDir = path.join(dir, 'out');
  fs.writeFileSync(registryPath, JSON.stringify(REGISTRY_331));
  execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'decoy', 'decoy.cjs'), '--registry', registryPath, '--out', outDir], { stdio: 'pipe' });
  const spec = JSON.parse(fs.readFileSync(path.join(outDir, 'openapi-decoy.json'), 'utf8'));
  assert.ok(spec.paths['/api/suppliers/SUP-F-01']);
  assert.ok(spec.paths['/graphql']);
  assert.ok(spec['x-graphql-schema'].includes('type WarehouseHeatmap {'));
  const bundle = JSON.parse(fs.readFileSync(path.join(outDir, 'decoy-bundle.json'), 'utf8'));
  assert.equal(bundle.surface.chains.length, 1);
  assert.equal(bundle.surface.identityVariants.length, 1);
  assert.equal(bundle.surface.graphql.path, '/graphql');
  fs.rmSync(dir, { recursive: true, force: true });
});
