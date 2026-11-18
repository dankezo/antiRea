const { test } = require('node:test');
const assert = require('node:assert/strict');
// ABP-08 BAIT-PATHS-AND-TRAP-DETECTION-MUST-SHARE-ONE-SOURCE: in
// the neighbour, bait paths and detectors were separate lists that
// drifted - 1 of 3 default and 2 of 3 custom example bait paths
// were invisible to the repo's own detectors, and /api/v2/users
// was undetected by all three. antiRea form: one registry
// (trap-paths.ts); the honeypot and fake-endpoint surfaces
// re-export its arrays, and every registered bait path is detected
// by its own surface.
const sdk = require('../dist/index.js');

const req = (url) => ({ url, headers: { get: () => null } });

test('the shipped surfaces re-export the registry arrays (same object, not copies)', () => {
  assert.equal(sdk.CANARY_ENDPOINTS, sdk.CANARY_TRAP_PATHS);
  assert.equal(sdk.FAKE_ENDPOINT_PATHS, sdk.FAKE_TRAP_PATHS);
});

test('the registry lists every shipped trap path exactly once, with its surface', () => {
  assert.equal(sdk.TRAP_PATH_REGISTRY.length, sdk.CANARY_TRAP_PATHS.length + sdk.FAKE_TRAP_PATHS.length);
  const paths = sdk.TRAP_PATH_REGISTRY.map(e => e.path);
  assert.equal(new Set(paths).size, paths.length);
  for (const entry of sdk.TRAP_PATH_REGISTRY) {
    assert.ok(entry.surface === 'canary' || entry.surface === 'fake-endpoint');
    assert.equal(sdk.isRegisteredTrapPath(entry.path), true, entry.path);
  }
});

test('every canary bait path is detected by the canary detector', async () => {
  for (const path of sdk.CANARY_TRAP_PATHS) {
    const res = await sdk.handleCanaryTrapRequest(req(path), {});
    assert.equal(res.isTrapped, true, path);
  }
});

test('every canary bait path is served by the decoy mirage default surface', async () => {
  const mirage = sdk.createDecoyMirage({});
  assert.deepEqual([...mirage.paths].sort(), [...sdk.CANARY_TRAP_PATHS].map(sdk.normalizeCanaryPath).sort());
  for (const path of sdk.CANARY_TRAP_PATHS) {
    const res = await mirage.handle(req(path));
    assert.equal(res.isDecoy, true, path);
  }
});

test('every fake-endpoint bait path is detected by its own detector', async () => {
  const pack = sdk.createFakeEndpoints({ enabled: true, echoSecret: 'abp08-secret' });
  assert.equal(pack.paths, sdk.FAKE_TRAP_PATHS);
  for (const path of sdk.FAKE_TRAP_PATHS) {
    assert.equal(sdk.isFakeEndpointPath(path), true, path);
    const res = await pack.handle(req(path));
    assert.equal(res.handled, true, path);
    assert.equal(res.isDecoy, true, path);
  }
});

test('detectors agree on unregistered paths (the /api/v2/users shape)', async () => {
  // The lab's undetected bait path: in antiRea the point is not that
  // this path is trapped - it is that NO surface claims it as bait
  // while another misses it. All three readings agree: not bait,
  // not detected, not registered.
  assert.equal(sdk.isRegisteredTrapPath('/api/v2/users'), false);
  assert.equal(sdk.isFakeEndpointPath('/api/v2/users'), false);
  const canary = await sdk.handleCanaryTrapRequest(req('/api/v2/users'), {});
  assert.equal(canary.isTrapped, false);
  const pack = sdk.createFakeEndpoints({ enabled: true, echoSecret: 'abp08-secret' });
  const fake = await pack.handle(req('/api/v2/users'));
  assert.equal(fake.handled, false);
});

test('registry lookup keeps each surface its documented matching semantics', () => {
  // Canary: normalized (case and trailing slash do not matter).
  assert.equal(sdk.isRegisteredTrapPath('/API/V1/INTERNAL/SCHEMA-EXPORT/'), true);
  // Fake endpoints: exact (case and trailing slash significant).
  assert.equal(sdk.isRegisteredTrapPath('/.ENV'), false);
  assert.equal(sdk.isRegisteredTrapPath('/wp-admin'), false); // registered form is /wp-admin/
  assert.equal(sdk.isRegisteredTrapPath('/wp-admin/'), true);
});
