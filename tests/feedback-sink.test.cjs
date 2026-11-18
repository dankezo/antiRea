'use strict';
// NHS-17 feedback sink - suite version of nhs-lab/nhs17.cjs. Frozen
// expectations: exactly the 3 local enforce-mode blocks exported, in
// order; feed-originated, pulled and shadow blocks all absent
// (ban-loop guard); every line complete; write is tmp+rename and the
// pre-drain file survives until the rename.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fb = require('../dist/tier2-active/feedback-sink.js');

function tmpSinkPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nhs17-'));
  return path.join(dir, 'sink.jsonl');
}

test('exactly the 3 local enforce-mode blocks are exported, in order; all others absent', () => {
  const file = tmpSinkPath();
  fs.writeFileSync(file, fb.formatFeedbackDecision('192.0.2.200', 'sentinel/http-abuse', 3600) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  const sink = fb.createFeedbackSink({ filePath: file });
  const events = [
    { ip: '203.0.113.1', origin: 'local', mode: 'enforce' },
    { ip: '203.0.113.2', origin: 'local', mode: 'enforce' },
    { ip: '203.0.113.3', origin: 'local', mode: 'enforce' },
    { ip: '198.51.100.1', origin: 'feed', mode: 'enforce' },
    { ip: '198.51.100.2', origin: 'pulled', mode: 'enforce' },
    { ip: '192.0.2.1', origin: 'local', mode: 'shadow' },
  ];
  const queued = events.map((ev) => sink.onBlock(ev));
  assert.deepEqual(queued, [true, true, true, false, false, false]);
  assert.deepEqual([...sink.pending()], ['203.0.113.1', '203.0.113.2', '203.0.113.3']);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'pre-drain snapshot intact until drain');
  const written = sink.drain();
  assert.equal(written, 3);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const parsed = lines.map((l) => JSON.parse(l));
  assert.deepEqual(parsed.map((p) => p.value), ['203.0.113.1', '203.0.113.2', '203.0.113.3']);
  assert.ok(!parsed.some((p) => p.value === '198.51.100.1'), 'feed-originated absent (ban-loop guard)');
  assert.ok(!parsed.some((p) => p.value === '198.51.100.2'), 'pulled absent (ban-loop guard)');
  assert.ok(!parsed.some((p) => p.value === '192.0.2.1'), 'shadow absent');
});

test('every line is complete: value/scope/duration/scenario/origin', () => {
  const file = tmpSinkPath();
  const sink = fb.createFeedbackSink({ filePath: file });
  sink.onBlock({ ip: '203.0.113.9', origin: 'local', mode: 'enforce' });
  sink.drain();
  const [p] = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(p.scope, 'Ip');
  assert.equal(p.duration, '3600s');
  assert.equal(p.scenario, 'sentinel/http-abuse');
  assert.equal(p.origin, 'sentinel');
  assert.equal(typeof p.value, 'string');
});

test('drain is tmp+rename: no tmp file remains, queue empties', () => {
  const file = tmpSinkPath();
  const sink = fb.createFeedbackSink({ filePath: file });
  sink.onBlock({ ip: '203.0.113.10', origin: 'local', mode: 'enforce' });
  sink.drain();
  assert.equal(fs.existsSync(file + '.tmp'), false);
  assert.deepEqual([...sink.pending()], []);
  assert.equal(sink.drain(), 0, 'second drain writes zero lines');
});
