'use strict';
/*
 * B-N4 decoy write surface (3.3.2) - safety + contract tests.
 *
 * The load-bearing test is the hostile-campaign differential:
 * a "real store" sentinel object held ONLY by this test (never
 * passed to the module - the module's options accept no store)
 * must stay byte-identical while routed writes pile up in the
 * module's own sink, and the audit must count exactly the
 * routed writes (Addendum E: non-existent decoy routes answer
 * plain 404 and are NOT routed, NOT sinked, NOT counted).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createDecoyWriteSurface,
  DecoyWriteSurfaceError,
  DECOY_WRITE_CONSTRAINTS,
} = require('../dist/tier2-active/decoy-write-surface.js');

function req(url, { method = 'GET', identity, body } = {}) {
  const headers = new Map();
  if (identity !== undefined) headers.set('x-identity', identity);
  return {
    url,
    method,
    headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
    body,
  };
}

const VALID = { name: 'Artisan Coffee Beans 1kg', sku_code: 'ABC-1234', price: '1.250.000 VND' };
const enabledSurface = (opts = {}) => createDecoyWriteSurface({ enabled: true, ...opts });
const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('disabled by default: nothing is handled, nothing is sinked', async () => {
  for (const h of [createDecoyWriteSurface(), createDecoyWriteSurface({ enabled: false })]) {
    assert.equal(h.enabled, false);
    const create = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: VALID }));
    assert.equal(create.handled, false);
    const del = await h.handle(req('/api/v2/items/dc_000001', { method: 'DELETE', identity: 'atk' }));
    assert.equal(del.handled, false);
    const audit = h.audit();
    assert.equal(audit.routedWrites, 0);
    assert.equal(audit.sinkSize, 0);
    assert.equal(audit.liveRecords, 0);
  }
});

test('construction throws on a write-route collision with a declared real route, and on wildcards (Layer 2)', () => {
  assert.throws(
    () => enabledSurface({ realRoutes: [{ method: 'POST', path: '/api/v2/items' }] }),
    DecoyWriteSurfaceError,
  );
  assert.throws(
    () => enabledSurface({ realRoutes: [{ method: 'delete', path: '/api/v2/items/{id}' }] }),
    DecoyWriteSurfaceError,
  );
  assert.throws(() => enabledSurface({ collectionPath: '/api/v2/*' }), DecoyWriteSurfaceError);
  // A real route that does NOT collide is fine.
  assert.doesNotThrow(() => enabledSurface({ realRoutes: [{ method: 'POST', path: '/api/items' }] }));
});

test('valid decoy create (all of F satisfied) => 201 with a dc_ id and exactly 1 sink entry', async () => {
  const h = enabledSurface();
  const r = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk-1', body: VALID }));
  assert.equal(r.handled, true);
  assert.equal(r.isDecoy, true);
  assert.equal(r.status, 201);
  const { record } = JSON.parse(r.body);
  assert.match(record.id, DECOY_WRITE_CONSTRAINTS.F3.idPattern);
  assert.equal(record.id, 'dc_000001');
  assert.equal(record.sku_code, 'ABC-1234');
  assert.equal(record.price, '1.250.000 VND');
  const audit = h.audit();
  assert.equal(audit.routedWrites, 1);
  assert.equal(audit.accepted, 1);
  assert.equal(audit.rejected, 0);
  assert.equal(audit.sinkSize, 1);
  assert.equal(audit.sinkEntries[0].outcome, 'accepted');
  assert.equal(audit.sinkEntries[0].id, 'dc_000001');
  assert.equal(audit.liveRecords, 1);
  assert.match(audit.sinkHash, /^[0-9a-f]{64}$/);
});

test('F1 violated (sku_code missing, then malformed) => 422 naming F1 / sku_code', async () => {
  const h = enabledSurface();
  const missing = { ...VALID };
  delete missing.sku_code;
  const r1 = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: missing }));
  assert.equal(r1.status, 422);
  const b1 = JSON.parse(r1.body);
  assert.ok(b1.errors.sku_code.includes('F1'), b1.errors.sku_code);
  assert.deepEqual(b1.violations, ['F1']);
  assert.deepEqual(r1.violations, ['F1']);

  const r2 = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: { ...VALID, sku_code: 'abc-123' } }));
  assert.equal(r2.status, 422);
  assert.ok(JSON.parse(r2.body).errors.sku_code.includes('sku_code'));
  // Rejected creates are routed writes: sinked, but no record is born.
  const audit = h.audit();
  assert.equal(audit.routedWrites, 2);
  assert.equal(audit.rejected, 2);
  assert.equal(audit.liveRecords, 0);
});

test('F2 violated (price as a JSON number - the REAL contract form) => 422 naming F2 / price', async () => {
  const h = enabledSurface();
  const r = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: { ...VALID, price: 1250000 } }));
  assert.equal(r.status, 422);
  const b = JSON.parse(r.body);
  assert.ok(b.errors.price.includes('F2'), b.errors.price);
  assert.ok(b.errors.price.includes('not a JSON number'), b.errors.price);
  assert.deepEqual(b.violations, ['F2']);
  // A wrongly formatted string violates F2 too.
  const r2 = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: { ...VALID, price: '1250000' } }));
  assert.equal(r2.status, 422);
  assert.deepEqual(JSON.parse(r2.body).violations, ['F2']);
});

test('F3 violated (client-supplied id outside the dc_ space) => 422 naming F3 / id', async () => {
  const h = enabledSurface();
  // 1001 is a REAL id (integer space from 1001) - the decoy contract rejects it as an id.
  const r = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: { ...VALID, id: 1001 } }));
  assert.equal(r.status, 422);
  const b = JSON.parse(r.body);
  assert.ok(b.errors.id.includes('F3'), b.errors.id);
  assert.deepEqual(b.violations, ['F3']);
  assert.equal(h.audit().liveRecords, 0);
});

test('multiple constraints violated at once => one 422 naming each of them', async () => {
  const h = enabledSurface();
  const r = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: { name: 'x', price: 5, id: 'zz' } }));
  assert.equal(r.status, 422);
  const b = JSON.parse(r.body);
  assert.deepEqual([...b.violations].sort(), ['F1', 'F2', 'F3']);
  assert.ok(b.errors.sku_code && b.errors.price && b.errors.id);
});

test('hostile write campaign: the real-store sentinel stays byte-identical; audit counts exactly the routed writes', async () => {
  // The sentinel "real store": held ONLY by this test. It is
  // never passed to the module - the module cannot reach it.
  const realStore = {
    items: new Map([
      [1001, { id: 1001, name: 'Real Coffee', price: 250000 }],
      [1002, { id: 1002, name: 'Real Tea', price: 180000 }],
    ]),
    orders: [{ id: 5001, total: 430000 }],
    note: 'real state - do not touch',
  };
  const snapshot = () => JSON.stringify({ items: [...realStore.items], orders: realStore.orders, note: realStore.note });
  const before = snapshot();
  const beforeHash = hashOf(before);

  const h = enabledSurface();
  const idn = 'atk-hostile';
  let routed = 0;
  const send = async (url, opts) => {
    const r = await h.handle(req(url, { identity: idn, ...opts }));
    return r;
  };

  // 3 valid creates.
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await send('/api/v2/items', { method: 'POST', body: { ...VALID, name: `Item ${i}` } });
    assert.equal(r.status, 201);
    ids.push(JSON.parse(r.body).record.id);
    routed++;
  }
  // Mixed invalid creates: F1, F2, F3, and an oversized junk payload.
  assert.equal((await send('/api/v2/items', { method: 'POST', body: { name: 'x' } })).status, 422); routed++;
  assert.equal((await send('/api/v2/items', { method: 'POST', body: { ...VALID, price: 1 } })).status, 422); routed++;
  assert.equal((await send('/api/v2/items', { method: 'POST', body: { ...VALID, id: 1001 } })).status, 422); routed++;
  assert.equal((await send('/api/v2/items', { method: 'POST', body: { ...VALID, junk: 'x'.repeat(100000) } })).status, 201); routed++;
  // Updates: valid PATCH, valid PUT, invalid PATCH (F1 still required on update).
  assert.equal((await send(`/api/v2/items/${ids[0]}`, { method: 'PATCH', body: { sku_code: 'XYZ-9876', price: '2.000.000 VND' } })).status, 200); routed++;
  assert.equal((await send(`/api/v2/items/${ids[1]}`, { method: 'PUT', body: { ...VALID, name: 'Replaced' } })).status, 200); routed++;
  assert.equal((await send(`/api/v2/items/${ids[0]}`, { method: 'PATCH', body: { price: '3.000.000 VND' } })).status, 422); routed++;
  // Writes addressed with REAL (integer) ids and unknown dc_ ids: routed, plain 404 inside the decoy world.
  assert.equal((await send('/api/v2/items/1001', { method: 'DELETE' })).status, 404); routed++;
  assert.equal((await send('/api/v2/items/1002', { method: 'PATCH', body: { sku_code: 'ABC-1234' } })).status, 404); routed++;
  assert.equal((await send('/api/v2/items/dc_999999', { method: 'DELETE' })).status, 404); routed++;
  // Deletes: one real decoy delete, one repeat delete (404).
  assert.equal((await send(`/api/v2/items/${ids[2]}`, { method: 'DELETE' })).status, 204); routed++;
  assert.equal((await send(`/api/v2/items/${ids[2]}`, { method: 'DELETE' })).status, 404); routed++;
  // Duplicate create (idempotent nothing - the decoy world just makes another dc_ record).
  assert.equal((await send('/api/v2/items', { method: 'POST', body: VALID })).status, 201); routed++;

  // The differential: real state is byte-identical after the campaign.
  assert.equal(snapshot(), before);
  assert.equal(hashOf(snapshot()), beforeHash);
  assert.equal(realStore.items.get(1001).name, 'Real Coffee');
  assert.equal(realStore.items.size, 2);

  // Sink accounting is exact: one entry per routed write, no more, no fewer.
  const audit = h.audit();
  assert.equal(audit.routedWrites, routed);
  assert.equal(audit.sinkSize, routed);
  assert.equal(audit.accepted + audit.rejected, routed);
  assert.equal(audit.sinkEntries.length, routed);
  assert.deepEqual(audit.sinkEntries.map((e) => e.seq), Array.from({ length: routed }, (_, i) => i + 1));
  // No sink entry ever carries a real (integer-space) record as accepted.
  for (const e of audit.sinkEntries) {
    if (e.outcome === 'accepted') assert.match(String(e.id), /^dc_\d{6}$/);
  }
});

test('writes to undefined decoy routes => plain 404, NOT counted, NOT sinked (Addendum E)', async () => {
  const h = enabledSurface();
  await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: VALID }));
  const before = h.audit();
  assert.equal(before.routedWrites, 1);

  const cases = [
    // Wrong method for the path shape: no such write route exists.
    req('/api/v2/items/dc_000001', { method: 'POST', identity: 'atk', body: VALID }),
    req('/api/v2/items', { method: 'PUT', identity: 'atk', body: VALID }),
    req('/api/v2/items', { method: 'DELETE', identity: 'atk' }),
    // Extra segments under the collection: no such route exists.
    req('/api/v2/items/dc_000001/history', { method: 'DELETE', identity: 'atk' }),
    req('/api/v2/items/dc_000001/history', { method: 'POST', identity: 'atk', body: VALID }),
  ];
  for (const c of cases) {
    const r = await h.handle(c);
    assert.equal(r.handled, true, `${c.method} ${c.url}`);
    assert.equal(r.status, 404, `${c.method} ${c.url}`);
    assert.equal(r.isDecoy, false);
  }
  const after = h.audit();
  assert.equal(after.routedWrites, before.routedWrites);
  assert.equal(after.sinkSize, before.sinkSize);
  assert.equal(after.sinkHash, before.sinkHash);
});

test('paths the surface does not own => handled:false, host routing continues', async () => {
  const h = enabledSurface();
  for (const c of [
    req('/api/items', { method: 'POST', identity: 'atk', body: { name: 'Real', price: 250000 } }),
    req('/api/items/1001', { method: 'DELETE', identity: 'atk' }),
    req('/api/v2', { method: 'POST', identity: 'atk', body: VALID }),
    req('/api/v2/itemsXYZ', { method: 'POST', identity: 'atk', body: VALID }),
    req('/robots.txt', { method: 'POST', identity: 'atk', body: VALID }),
    req('/', { method: 'DELETE', identity: 'atk' }),
  ]) {
    const r = await h.handle(c);
    assert.equal(r.handled, false, `${c.method} ${c.url}`);
  }
  assert.equal(h.audit().routedWrites, 0);
});

test('update/delete round-trip inside the decoy world works with dc_ ids', async () => {
  const h = enabledSurface();
  const idn = 'atk-rt';
  const created = await h.handle(req('/api/v2/items', { method: 'POST', identity: idn, body: VALID }));
  const id = JSON.parse(created.body).record.id;

  const patched = await h.handle(req(`/api/v2/items/${id}`, { method: 'PATCH', identity: idn, body: { sku_code: 'DEF-5555', price: '9.990.000 VND' } }));
  assert.equal(patched.status, 200);
  assert.equal(JSON.parse(patched.body).record.price, '9.990.000 VND');
  assert.equal(JSON.parse(patched.body).record.sku_code, 'DEF-5555');
  assert.equal(JSON.parse(patched.body).record.name, VALID.name, 'PATCH merges: untouched fields survive');

  const replaced = await h.handle(req(`/api/v2/items/${id}`, { method: 'PUT', identity: idn, body: { name: 'New Name', sku_code: 'GHI-0001', price: '100.000 VND' } }));
  assert.equal(replaced.status, 200);
  assert.equal(JSON.parse(replaced.body).record.name, 'New Name');

  // Read-back sees the decoy record; another identity does not.
  const readBack = await h.handle(req(`/api/v2/items/${id}`, { method: 'GET', identity: idn }));
  assert.equal(readBack.status, 200);
  assert.equal(JSON.parse(readBack.body).record.name, 'New Name');
  const stranger = await h.handle(req(`/api/v2/items/${id}`, { method: 'GET', identity: 'someone-else' }));
  assert.equal(stranger.status, 404);
  const list = await h.handle(req('/api/v2/items', { method: 'GET', identity: idn }));
  assert.equal(JSON.parse(list.body).records.length, 1);
  // Reads are not routed writes.
  assert.equal(h.audit().routedWrites, 3);

  const del = await h.handle(req(`/api/v2/items/${id}`, { method: 'DELETE', identity: idn }));
  assert.equal(del.status, 204);
  assert.equal(del.body, '');
  const gone = await h.handle(req(`/api/v2/items/${id}`, { method: 'GET', identity: idn }));
  assert.equal(gone.status, 404);
  assert.equal(h.audit().liveRecords, 0);
  assert.equal(h.audit().routedWrites, 4);
});

test('onLog fires once per routed write in the fixed shape, and a throwing onLog never breaks the host', async () => {
  const entries = [];
  const h = enabledSurface({ onLog: (e) => entries.push(e) });
  await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: VALID }));
  await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: {} }));
  await h.handle(req('/api/v2/items/dc_000001/history', { method: 'DELETE', identity: 'atk' })); // not routed: no log
  assert.equal(entries.length, 2);
  assert.equal(entries[0].source, 'decoy-write-surface');
  assert.equal(entries[0].kind, 'create');
  assert.equal(entries[0].status, 201);
  assert.equal(entries[1].status, 422);

  const hostile = enabledSurface({
    onLog: () => {
      throw new Error('log sink exploded');
    },
  });
  const r = await hostile.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: VALID }));
  assert.equal(r.status, 201);
});

test('custom collectionPath relocates the whole surface; body as a JSON string is accepted', async () => {
  const h = enabledSurface({ collectionPath: '/api/v9/widgets' });
  const r = await h.handle(req('/api/v9/widgets', { method: 'POST', identity: 'atk', body: JSON.stringify(VALID) }));
  assert.equal(r.status, 201);
  assert.match(JSON.parse(r.body).record.id, /^dc_\d{6}$/);
  const old = await h.handle(req('/api/v2/items', { method: 'POST', identity: 'atk', body: VALID }));
  assert.equal(old.handled, false);
  assert.deepEqual(h.routes, [
    'POST /api/v9/widgets',
    'PUT /api/v9/widgets/{id}',
    'PATCH /api/v9/widgets/{id}',
    'DELETE /api/v9/widgets/{id}',
  ]);
});
