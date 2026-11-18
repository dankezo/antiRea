const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');
const SECRET = 'rsp16-test-secret';

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

test('RSP-16 config and HEAD exact; listings exact', () => {
  const g = sdk.createRspGitLoop({ secret: SECRET });
  assert.ok(g.route('/.git/config').body.includes('repositoryformatversion'));
  assert.ok(g.route('/.git/HEAD').body.includes('refs/heads/main'));
  assert.equal(g.route('/.git/objects/').entries.length, 16);
  const sub = g.route('/.git/objects/ab/');
  assert.equal(sub.entries.length, 10);
  const objPage = g.route('/.git/objects/ab/' + 'f'.repeat(38));
  assert.equal(objPage.entries.length, 3);
  const packDir = g.route('/.git/objects/pack/');
  assert.equal(packDir.entries.length, 2);
  assert.ok(packDir.entries[0].endsWith('.idx') && packDir.entries[1].endsWith('.pack'));
});

test('RSP-16 fidelity fixes: object names are 40 chars; .idx carries idx magic, .pack carries PACK', () => {
  assert.equal(sdk.rspGitObjectName(SECRET, 'seed-1').length, 40);
  const g = sdk.createRspGitLoop({ secret: SECRET });
  const pack = g.route('/.git/objects/pack/pack-x.pack');
  assert.equal(pack.bytes.length, 8192);
  assert.equal(String.fromCharCode(...pack.bytes.slice(0, 4)), 'PACK');
  assert.equal(pack.bytes[7], 2);
  const idx = g.route('/.git/objects/pack/pack-x.idx');
  assert.deepEqual([...idx.bytes.slice(0, 4)], [0xff, 0x74, 0x4f, 0x63]);
});

test('RSP-16 200 seeded walks of depth 8: 0 dead ends, 0 404s; BFS transcripts byte-identical', () => {
  const g = sdk.createRspGitLoop({ secret: SECRET });
  const rng = mulberry32(20320117);
  let deadEnds = 0, notFound = 0;
  for (let w = 0; w < 200; w++) {
    let current = '/.git/objects/';
    for (let d = 0; d < 8; d++) {
      const r = g.route(current);
      if (r.status === 404) { notFound++; break; }
      if (r.kind !== 'listing' || r.entries.length === 0) { deadEnds++; break; }
      const next = r.entries[Math.floor(rng() * r.entries.length)];
      current = current + next + (next.endsWith('/') ? '' : '/');
    }
  }
  assert.equal(deadEnds, 0);
  assert.equal(notFound, 0);
  const bfs = () => {
    const out = [];
    const queue = ['/.git/objects/'];
    while (queue.length && out.length < 60) {
      const p = queue.shift();
      const r = g.route(p);
      out.push(p + '|' + r.status + '|' + (r.entries ? r.entries.join(',') : r.kind));
      if (r.entries) for (const e of r.entries.slice(0, 3)) queue.push(p + e + (e.endsWith('/') ? '' : '/'));
    }
    return out.join('\n');
  };
  assert.equal(bfs(), bfs());
});
