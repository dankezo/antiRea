'use strict';
// MGH-02 breadcrumb lure chain, V1 form only - suite version of
// mgh-lab/mgh02.cjs. Agent arms are the frozen rule-based simulations
// of REGISTRATION-MGH-STEP0.md (not real agents); expectations are
// the frozen gates: CHAIN-DEPTH, SIGNAL-PRECISION, CONTROL,
// SEPARATION, HYGIENE. V0 (401 shell, 0 events) is the defect V1
// fixes and is not built.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bl = require('../dist/tier2-active/breadcrumb-lure.js');
const bp = require('../dist/tier2-active/bait-persona.js');

function personaFor(rep) {
  const secret = crypto.createHash('sha256').update(`mgh02-suite-persona-${rep}`).digest('hex');
  return bp.generateBaitPersona(secret);
}

const mockReq = (path, clientKey, method = 'GET', body) => ({
  url: `https://example.test${path}`,
  method,
  body,
  headers: { get: (k) => (k.toLowerCase() === 'user-agent' ? clientKey : null) },
});

function makePack(events, rep, extra = {}) {
  return bl.createBreadcrumbLure({
    enabled: true,
    persona: personaFor(rep),
    resolveClientKey: (req) => req.headers.get('user-agent'),
    onEvent: (e) => events.push(e),
    ...extra,
  });
}

// Frozen agent arms, ported from mgh02.cjs.
async function agCompliant(pack, key, trace) {
  trace.push({ path: '/robots.txt', ...(await pack.handle(mockReq('/robots.txt', key))) });
  const root = await pack.handle(mockReq('/', key));
  trace.push({ path: '/', ...root });
}
async function agLlmsReader(pack, key, trace) {
  trace.push({ path: '/robots.txt', ...(await pack.handle(mockReq('/robots.txt', key))) });
  trace.push({ path: '/llms.txt', ...(await pack.handle(mockReq('/llms.txt', key))) });
}
async function agChain(pack, key, trace, llmsBodyOverride) {
  trace.push({ path: '/robots.txt', ...(await pack.handle(mockReq('/robots.txt', key))) });
  let llmsBody;
  if (llmsBodyOverride !== undefined) {
    trace.push({ path: '/llms.txt', status: 200, body: llmsBodyOverride });
    llmsBody = llmsBodyOverride;
  } else {
    const r = await pack.handle(mockReq('/llms.txt', key));
    trace.push({ path: '/llms.txt', ...r });
    llmsBody = r.body;
  }
  const m = llmsBody.match(/\]\((\/[^)\s]+)\)/);
  if (!m) return 1;
  const spec = await pack.handle(mockReq(m[1], key));
  trace.push({ path: m[1], ...spec });
  const pm = spec.body.match(/^\s+(\/\S+):/m);
  if (!pm) return 2;
  const shell = await pack.handle(mockReq(pm[1], key, 'POST', JSON.stringify({ cmd: 'id' })));
  trace.push({ path: pm[1], ...shell });
  return 3;
}
async function agScanner(pack, key, trace) {
  for (const p of ['/.env', '/config/', '/admin/', '/api/v1/debug']) {
    trace.push({ path: p, ...(await pack.handle(mockReq(p, key))) });
  }
}

test('CHAIN-DEPTH: AG-CHAIN completes depth 3 in 8/8 reps with exactly 1 decoy-shell event each', async () => {
  for (let rep = 0; rep < 8; rep++) {
    const events = [];
    const pack = makePack(events, rep);
    const key = `chain-client-${rep}`;
    const trace = [];
    const depth = await agChain(pack, key, trace);
    assert.equal(depth, 3, `rep ${rep}`);
    const paths = trace.map((t) => t.path);
    assert.equal(bl.isBreadcrumbFollowThrough(paths), true, `rep ${rep}`);
    assert.equal(bl.breadcrumbDepth(paths), 3, `rep ${rep}`);
    const shellEvents = events.filter((e) => e.type === 'decoy-shell');
    assert.equal(shellEvents.length, 1, `rep ${rep} must produce exactly 1 decoy-shell event`);
    assert.equal(shellEvents[0].path, '/api/v1/admin/shell');
    assert.equal(shellEvents[0].cmd, 'id');
    const shellResult = trace.find((t) => t.path === '/api/v1/admin/shell');
    assert.equal(shellResult.status, 200, 'V1 shell answers 200, not the V0 401');
    assert.match(shellResult.body, /uid=33\(www-data\)/);
    assert.equal(shellResult.followThrough, true);
  }
});

test('SIGNAL-PRECISION: compliant and llms-reader agents produce 0 follow-through signals (8 reps each)', async () => {
  for (let rep = 0; rep < 8; rep++) {
    for (const [name, arm] of [['compliant', agCompliant], ['llms-reader', agLlmsReader]]) {
      const events = [];
      const pack = makePack(events, rep);
      const key = `${name}-${rep}`;
      const trace = [];
      await arm(pack, key, trace);
      const paths = trace.map((t) => t.path);
      assert.equal(bl.isBreadcrumbFollowThrough(paths), false, `${name} rep ${rep}`);
      assert.equal(events.filter((e) => e.type === 'decoy-shell').length, 0, `${name} rep ${rep}`);
    }
  }
});

test('CONTROL: against a single static decoy document with no links, AG-CHAIN stops at depth 1 with 0 signals in 8/8', async () => {
  for (let rep = 0; rep < 8; rep++) {
    const events = [];
    const pack = makePack(events, rep);
    const persona = personaFor(rep);
    const controlDoc =
      `# ${persona.company} Internal API\n\n> Internal administrative API for ${persona.company} operations staff.\n\n` +
      'Reference document for the operations portal. Endpoint details are available through the operations console.\n';
    const trace = [];
    const depth = await agChain(pack, `control-${rep}`, trace, controlDoc);
    assert.ok(depth <= 1, `rep ${rep} depth ${depth}`);
    assert.equal(bl.isBreadcrumbFollowThrough(trace.map((t) => t.path)), false);
    assert.equal(events.filter((e) => e.type === 'decoy-shell').length, 0);
  }
});

test('SEPARATION: scanner direct probes stay a separate signal type (4 events, 0 follow-through, 8/8)', async () => {
  for (let rep = 0; rep < 8; rep++) {
    const events = [];
    const pack = makePack(events, rep);
    const trace = [];
    await agScanner(pack, `scanner-${rep}`, trace);
    const paths = trace.map((t) => t.path);
    assert.equal(bl.countBreadcrumbDirectProbes(paths), 4, `rep ${rep}`);
    assert.equal(bl.isBreadcrumbFollowThrough(paths), false, `rep ${rep}`);
    assert.equal(events.filter((e) => e.type === 'direct-probe').length, 4, `rep ${rep}`);
    assert.equal(events.filter((e) => e.type === 'decoy-shell').length, 0, `rep ${rep}`);
  }
});

test('HYGIENE: advertised paths inside the decoy-only set, real route advertised nowhere, lint 0 matches', () => {
  const docs = bl.buildBreadcrumbDocuments(personaFor(0));
  assert.deepEqual(bl.lintBreadcrumbDocuments(docs, ['/api/real/records']), []);
  for (const text of [docs.robotsTxt, docs.llmsTxt, docs.openapiYaml, docs.envBody]) {
    assert.ok(!text.includes('/api/real/records'), 'real route must appear in no chain document');
  }
  assert.deepEqual([...bl.BREADCRUMB_DECOY_PATHS], [
    '/', '/robots.txt', '/llms.txt', '/openapi.yaml', '/.env', '/config/.env',
    '/config/', '/admin/', '/api/v1/debug', '/api/v1/admin/shell', '/sitemap.xml',
  ]);
});

test('default OFF: chain paths answer 404 and record no events or traces', async () => {
  const events = [];
  const pack = bl.createBreadcrumbLure({
    persona: personaFor(0),
    resolveClientKey: () => 'off-client',
    onEvent: (e) => events.push(e),
  });
  assert.equal(pack.enabled, false);
  for (const [p, m] of [['/llms.txt', 'GET'], ['/openapi.yaml', 'GET'], ['/.env', 'GET'], ['/api/v1/admin/shell', 'POST']]) {
    const r = await pack.handle(mockReq(p, 'off-client', m, JSON.stringify({ cmd: 'id' })));
    assert.equal(r.status, 404, p);
    assert.equal(r.isDecoy, false, p);
  }
  assert.equal(events.length, 0);
  assert.deepEqual([...pack.traceFor('off-client')], []);
  const real = await pack.handle(mockReq('/api/orders', 'off-client'));
  assert.equal(real.handled, false, 'pack is never mounted on a real route');
});

test('shell executes nothing: unknown commands get the frozen not-found template, exactly 1 event each', async () => {
  const events = [];
  const pack = makePack(events, 0);
  const r = await pack.handle(mockReq('/api/v1/admin/shell', 'shell-client', 'POST', JSON.stringify({ cmd: 'cat /etc/passwd' })));
  assert.equal(r.status, 200);
  assert.equal(r.body, 'www-data@web01:~$ cat /etc/passwd\nbash: cat: command not found\n');
  assert.ok(!r.body.includes('root:'), 'no real file content is ever served');
  assert.equal(events.filter((e) => e.type === 'decoy-shell').length, 1);
  assert.equal(events[0].cmd, 'cat /etc/passwd');
});
