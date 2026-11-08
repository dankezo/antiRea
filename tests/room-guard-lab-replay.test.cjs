const { test } = require('node:test');
const assert = require('node:assert/strict');
// Room guard LAB REPLAY (test-battery upgrade, 2026-11-09).
//
// The 2.8.0 unit tests pin the laws on small hand-built streams; this
// file closes the gap they leave: it replays the FROZEN RECOMB-06
// lab populations themselves (REGISTRATION-RECOMB-06-ROOMGUARD-2,
// seeds 20296001-20296091, results in RECOMB06-RESULTS.md) through
// the SHIPPED createRoomGuard and asserts the same gates the lab
// verdict rested on:
//   - G-FP1: STEADY / RAID / SCHEDULED / KARAOKE / KARAOKE-SILENT
//     never flag in 7 days.
//   - G-B1 FLOOD first flag <= 120 s after bot start (lab: 60 s).
//   - G-B2 DRIP first flag <= 2,700 s (lab: 1,950 s).
//   - G-B3 CHURN first flag <= 900 s (lab: 30 s).
//   - G-B4 SQUAT first flag <= 900 s, via the occupancy path
//     (lab: 690 s, occupancy FAST).
//   - G-B7 SQUAT-DRIP: occupancy flags >= 1,800 s before the last
//     drip bot has even joined (lab lead: 5,100 s).
// The event generators below are verbatim copies of the lab's
// sim-lib.cjs / recomb06-lib.cjs / cand-lib.cjs builders (the only
// edit: makeCell also allocates the sessions array the cand-lib
// builders push into; the shipped feed consumes events only). Each
// cell test first asserts the port reproduces the lab's published
// joins/events counts exactly, so a porting drift fails loudly here
// instead of silently weakening the assertions. Lab timestamps are
// seconds; the shipped API is milliseconds (x1000).
const { createRoomGuard } = require('../dist/index.js');

const DAY = 86400;
const DAYS = 7;

/* ---- frozen lab generators (verbatim ports, see header) ---- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function streamRng(baseSeed, streamIndex, runIdx) {
  return mulberry32(
    (baseSeed ^ Math.imul(streamIndex + 1, 0x9e3779b1) ^ Math.imul(runIdx + 1, 0x85ebca6b)) >>> 0,
  );
}
function makeCell(seed) {
  return { seed, events: [], created: new Map(), sessions: [] };
}
function reg(cell, identity, createdTs) {
  if (!cell.created.has(identity)) cell.created.set(identity, createdTs);
}
function pushSession(cell, identity, room, joinTs, dwellSec, rng, activity) {
  cell.events.push({ type: 'join', identity, room, ts: joinTs });
  if (activity) {
    let t = joinTs + 60 + Math.floor(rng() * 240);
    const end = joinTs + dwellSec;
    while (t < end) {
      cell.events.push({ type: 'activity', identity, room, ts: t });
      t += 120 + Math.floor(rng() * 240);
    }
  }
  cell.events.push({ type: 'leave', identity, room, ts: joinTs + dwellSec });
}
function legitDay(cell, identity, day, room, roomKind, rng, rate) {
  const r = rng();
  let sessions = r < 0.35 ? 0 : r < 0.85 ? 1 : 2;
  for (let s = 0; s < sessions; s++) {
    if (rate < 1 && rng() >= rate) continue;
    let hour;
    let dwell;
    if (roomKind === 'karaoke') {
      hour = 19 + Math.floor(rng() * 4);
      dwell = (10 + rng() * 30) * 60;
    } else {
      hour = 17 + Math.floor(rng() * 7);
      dwell = (15 + rng() * 135) * 60;
    }
    const joinTs = day * DAY + hour * 3600 + Math.floor(rng() * 3600);
    pushSession(cell, identity, room, joinTs, Math.round(dwell), rng, true);
  }
}
function buildLegitBackground(cell, room, roomKind, rate, streamBase) {
  const poolRng = streamRng(cell.seed, streamBase, 0);
  const pool = [];
  for (let i = 0; i < 140; i++) {
    const id = `user-${i}`;
    reg(cell, id, -Math.floor((2 + poolRng() * 28) * DAY));
    pool.push(id);
  }
  for (let day = 0; day < DAYS; day++) {
    for (let i = 0; i < pool.length; i++) {
      const rng = streamRng(cell.seed, streamBase + 1000 + i * 16 + day, 0);
      legitDay(cell, pool[i], day, room, roomKind, rng, rate);
    }
    for (let k = 0; k < 5; k++) {
      const id = `new-${day}-${k}`;
      const createdTs = day * DAY + (8 + Math.floor(poolRng() * 14)) * 3600 + Math.floor(poolRng() * 3600);
      reg(cell, id, createdTs);
      const rng = streamRng(cell.seed, streamBase + 5000 + day * 16 + k, 0);
      const n = 1 + Math.floor(rng() * 3);
      for (let s = 0; s < n; s++) {
        const hour = 17 + Math.floor(rng() * 7);
        const joinTs = Math.max(createdTs + 60, day * DAY + hour * 3600 + Math.floor(rng() * 3600));
        const dwell = roomKind === 'karaoke' ? (10 + rng() * 30) * 60 : (15 + rng() * 135) * 60;
        pushSession(cell, id, room, joinTs, Math.round(dwell), rng, true);
      }
      for (let d2 = day + 1; d2 < DAYS; d2++) {
        const rng2 = streamRng(cell.seed, streamBase + 9000 + day * 100 + k * 16 + d2, 0);
        legitDay(cell, id, d2, room, roomKind, rng2, rate);
      }
    }
  }
  return pool;
}
function burst(cell, pool, day, startSec, count, spreadSec, minDwellSec, room, streamIdx) {
  const rng = streamRng(cell.seed, streamIdx, 0);
  const idx = pool.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  const chosen = idx.slice(0, count).map((i) => pool[i]);
  for (const id of chosen) {
    const joinTs = day * DAY + startSec + Math.floor(rng() * spreadSec);
    const dwell = minDwellSec + Math.floor(rng() * 1800);
    pushSession(cell, id, room, joinTs, dwell, rng, true);
  }
}
function cellSteady(seed) {
  const cell = makeCell(seed);
  buildLegitBackground(cell, 'main', 'main', 1, 100);
  return { cell, room: 'main', capacity: 100 };
}
function cellRaid(seed) {
  const cell = makeCell(seed);
  const pool = buildLegitBackground(cell, 'main', 'main', 0.3, 100);
  burst(cell, pool, 5, 20 * 3600 + 1800, 50, 120, 2700, 'main', 777);
  return { cell, room: 'main', capacity: 100, botStart: 5 * DAY + 20 * 3600 + 1800 };
}
function cellScheduled(seed) {
  const cell = makeCell(seed);
  const pool = buildLegitBackground(cell, 'main', 'main', 0.3, 100);
  burst(cell, pool, 5, 20 * 3600, 60, 60, 3600, 'main', 777);
  return { cell, room: 'main', capacity: 100, botStart: 5 * DAY + 20 * 3600 };
}
function cellKaraoke(seed) {
  const cell = makeCell(seed);
  buildLegitBackground(cell, 'karaoke', 'karaoke', 1, 100);
  return { cell, room: 'karaoke', capacity: 30 };
}
function cellFlood(seed) {
  const cell = makeCell(seed);
  buildLegitBackground(cell, 'main', 'main', 1, 100);
  const start = 5 * DAY + 21 * 3600;
  const rng = streamRng(cell.seed, 4242, 0);
  for (let i = 0; i < 200; i++) {
    const id = `floodbot-${i}`;
    reg(cell, id, 5 * DAY + Math.floor(rng() * 3600));
    const joinTs = start + Math.floor(rng() * 10);
    cell.events.push({ type: 'join', identity: id, room: 'main', ts: joinTs });
    cell.events.push({ type: 'leave', identity: id, room: 'main', ts: joinTs + 600 });
  }
  return { cell, room: 'main', capacity: 100, botStart: start };
}
function cellDrip(seed) {
  const cell = makeCell(seed);
  buildLegitBackground(cell, 'main', 'main', 1, 100);
  const start = 5 * DAY + 21 * 3600;
  let t = start;
  let i = 0;
  while (t < start + 3600) {
    const id = `dripbot-${i}`;
    reg(cell, id, 5 * DAY + Math.floor(t % 3600));
    cell.events.push({ type: 'join', identity: id, room: 'main', ts: t });
    cell.events.push({ type: 'leave', identity: id, room: 'main', ts: t + 3600 });
    t += i % 2 === 0 ? 30 : 60;
    i++;
  }
  return { cell, room: 'main', capacity: 100, botStart: start };
}
function cellChurn(seed) {
  const cell = makeCell(seed);
  buildLegitBackground(cell, 'main', 'main', 1, 100);
  const start = 5 * DAY + 21 * 3600;
  for (let i = 0; i < 40; i++) {
    const id = `churnbot-${i}`;
    reg(cell, id, 5 * DAY + (i % 60));
    let t = start + (i % 25);
    while (t < start + 1800) {
      cell.events.push({ type: 'join', identity: id, room: 'main', ts: t });
      cell.events.push({ type: 'leave', identity: id, room: 'main', ts: t + 5 });
      t += 25;
    }
  }
  return { cell, room: 'main', capacity: 100, botStart: start };
}
function cellSquat(seed) {
  const cell = makeCell(seed);
  buildLegitBackground(cell, 'karaoke', 'karaoke', 1, 100);
  const start = 5 * DAY + 19 * 3600 + 1800;
  const rng = streamRng(cell.seed, 4242, 0);
  for (let i = 0; i < 30; i++) {
    const id = `squatbot-${i}`;
    reg(cell, id, 5 * DAY + Math.floor(rng() * 3600));
    const joinTs = start + Math.floor(rng() * 120);
    cell.events.push({ type: 'join', identity: id, room: 'karaoke', ts: joinTs });
    cell.events.push({ type: 'leave', identity: id, room: 'karaoke', ts: joinTs + 3600 });
  }
  return { cell, room: 'karaoke', capacity: 30, botStart: start };
}
function pushSessionC(cell, identity, room, joinTs, dwellSec, rng, activity) {
  cell.events.push({ type: 'join', identity, room, ts: joinTs });
  cell.sessions.push({ identity, room, joinTs, leaveTs: joinTs + dwellSec });
  if (activity) {
    let t = joinTs + 60 + Math.floor(rng() * 240);
    const end = joinTs + dwellSec;
    while (t < end) {
      cell.events.push({ type: 'activity', identity, room, ts: t });
      t += 120 + Math.floor(rng() * 240);
    }
  }
  cell.events.push({ type: 'leave', identity, room, ts: joinTs + dwellSec });
}
function legitDayC(cell, identity, day, room, roomKind, rng, rate, opts) {
  const r = rng();
  let sessions = r < 0.35 ? 0 : r < 0.85 ? 1 : 2;
  for (let s = 0; s < sessions; s++) {
    if (rate < 1 && rng() >= rate) continue;
    let hour, dwell;
    if (roomKind === 'karaoke') {
      hour = 19 + Math.floor(rng() * 4);
      dwell = (10 + rng() * 30) * 60;
    } else {
      hour = 17 + Math.floor(rng() * 7);
      dwell = (15 + rng() * 135) * 60;
    }
    const joinTs = day * DAY + hour * 3600 + Math.floor(rng() * 3600);
    const silent = roomKind === 'karaoke' && rng() < (opts.silentSeatShare || 0);
    pushSessionC(cell, identity, room, joinTs, Math.round(dwell), rng, !silent);
  }
}
function buildBackgroundC(cell, room, roomKind, rate, streamBase, opts = {}) {
  const poolRng = streamRng(cell.seed, streamBase, 0);
  const pool = [];
  for (let i = 0; i < 140; i++) {
    const id = `user-${i}`;
    reg(cell, id, -Math.floor((2 + poolRng() * 28) * DAY));
    pool.push(id);
  }
  const newPerDay = opts.newPerDay || 5;
  for (let day = 0; day < DAYS; day++) {
    for (let i = 0; i < pool.length; i++) {
      const rng = streamRng(cell.seed, streamBase + 1000 + i * 16 + day, 0);
      legitDayC(cell, pool[i], day, room, roomKind, rng, rate, opts);
    }
    for (let k = 0; k < newPerDay; k++) {
      const id = `new-${day}-${k}`;
      const createdTs = day * DAY + (8 + Math.floor(poolRng() * 14)) * 3600 + Math.floor(poolRng() * 3600);
      reg(cell, id, createdTs);
      const rng = streamRng(cell.seed, streamBase + 5000 + day * 16 + k, 0);
      const n = 1 + Math.floor(rng() * 3);
      for (let s = 0; s < n; s++) {
        const hour = 17 + Math.floor(rng() * 7);
        const joinTs = Math.max(createdTs + 60, day * DAY + hour * 3600 + Math.floor(rng() * 3600));
        const dwell = roomKind === 'karaoke' ? (10 + rng() * 30) * 60 : (15 + rng() * 135) * 60;
        const silent = roomKind === 'karaoke' && rng() < (opts.silentNewShare || 0);
        pushSessionC(cell, id, room, joinTs, Math.round(dwell), rng, !silent);
      }
      for (let d2 = day + 1; d2 < DAYS; d2++) {
        const rng2 = streamRng(cell.seed, streamBase + 9000 + day * 100 + k * 16 + d2, 0);
        legitDayC(cell, id, d2, room, roomKind, rng2, rate, opts);
      }
    }
  }
  return pool;
}
function cellKaraokeSilent(seed, opts = {}) {
  const cell = makeCell(seed);
  buildBackgroundC(cell, 'karaoke', 'karaoke', 1, 100, opts);
  return { cell, room: 'karaoke' };
}
function cellSquatDrip(seed) {
  const cell = makeCell(seed);
  buildBackgroundC(cell, 'karaoke', 'karaoke', 1, 100, {});
  const start = 5 * DAY + 17 * 3600;
  const endHold = 5 * DAY + 23 * 3600 + 1800;
  const rng = streamRng(cell.seed, 4243, 0);
  let t = start;
  for (let i = 0; i < 30; i++) {
    const id = `dripbot-${i}`;
    reg(cell, id, 5 * DAY + Math.floor(rng() * 3600));
    cell.events.push({ type: 'join', identity: id, room: 'karaoke', ts: t });
    cell.sessions.push({ identity: id, room: 'karaoke', joinTs: t, leaveTs: endHold });
    cell.events.push({ type: 'leave', identity: id, room: 'karaoke', ts: endHold });
    t += i % 2 === 0 ? 600 : 300; // 1 seat per ~450 s average (1-2 per 10 min)
  }
  return { cell, room: 'karaoke', botStart: start, dripDoneTs: t };
}

/* ---- replay harness ---- */
function feedCell(built, capacity) {
  const { cell, room } = built;
  const events = cell.events.filter((e) => e.room === room).sort((a, b) => a.ts - b.ts);
  const joins = events.filter((e) => e.type === 'join').length;
  const guard = createRoomGuard({ capacity });
  for (const e of events) {
    guard.observe({
      type: e.type,
      identity: e.identity,
      ts: e.ts * 1000,
      accountCreatedTs: cell.created.get(e.identity) * 1000,
    });
  }
  const result = guard.evaluate({ asOfTs: DAYS * DAY * 1000 });
  return { result, joins, eventsTotal: events.length };
}

const CELLS = [
  { name: 'STEADY', build: () => cellSteady(20296001), capacity: 100, joins: 886, events: 19898, legit: true },
  { name: 'RAID', build: () => cellRaid(20296011), capacity: 100, joins: 386, events: 8336, legit: true },
  { name: 'SCHEDULED', build: () => cellScheduled(20296021), capacity: 100, joins: 399, events: 8924, legit: true },
  { name: 'KARAOKE', build: () => cellKaraoke(20296031), capacity: 30, joins: 961, events: 7784, legit: true },
  { name: 'KARAOKE-SILENT', build: () => cellKaraokeSilent(20296041, { silentSeatShare: 0.6, silentNewShare: 0.6 }), capacity: 30, joins: 926, events: 4072, legit: true },
  { name: 'FLOOD', build: () => cellFlood(20296051), capacity: 100, joins: 1113, events: 20657, botStart: 5 * DAY + 21 * 3600, gateMs: 120000 },
  { name: 'DRIP', build: () => cellDrip(20296061), capacity: 100, joins: 1025, events: 21033, botStart: 5 * DAY + 21 * 3600, gateMs: 2700000 },
  { name: 'CHURN', build: () => cellChurn(20296071), capacity: 100, joins: 3792, events: 26679, botStart: 5 * DAY + 21 * 3600, gateMs: 900000 },
  { name: 'SQUAT', build: () => cellSquat(20296081), capacity: 30, joins: 981, events: 7576, botStart: 5 * DAY + 19 * 3600 + 1800, gateMs: 900000, occupancy: true },
];

for (const c of CELLS) {
  test(`lab replay ${c.name}: port integrity + frozen gate`, () => {
    const built = c.build();
    // Port integrity: the generator copy must reproduce the lab's
    // published stream sizes exactly before any verdict is trusted.
    const roomEvents = built.cell.events.filter((e) => e.room === built.room);
    assert.equal(roomEvents.filter((e) => e.type === 'join').length, c.joins, `${c.name} joins drifted from the lab record`);
    assert.equal(roomEvents.length, c.events, `${c.name} events drifted from the lab record`);
    const { result } = feedCell(built, c.capacity);
    if (c.legit) {
      assert.equal(result.flagged, false, `${c.name} must never flag (G-FP1)`);
      assert.equal(result.firstFlagTs, null);
    } else {
      assert.equal(result.flagged, true, `${c.name} must flag`);
      const delay = result.firstFlagTs - c.botStart * 1000;
      assert.ok(delay >= 0 && delay <= c.gateMs, `${c.name} first flag at +${delay / 1000}s, gate ${c.gateMs / 1000}s`);
      if (c.occupancy) assert.equal(result.paths.occupancy, true, 'SQUAT must be caught by the occupancy path');
    }
  });
}

test('lab replay SQUAT-DRIP: occupancy warns before the drip completes (G-B7)', () => {
  const built = cellSquatDrip(20296091);
  const roomEvents = built.cell.events.filter((e) => e.room === 'karaoke');
  assert.equal(roomEvents.filter((e) => e.type === 'join').length, 931, 'SQUAT-DRIP joins drifted from the lab record');
  assert.equal(roomEvents.length, 7353, 'SQUAT-DRIP events drifted from the lab record');
  const lastDripJoin = Math.max(...built.cell.events.filter((e) => e.type === 'join' && e.identity.startsWith('dripbot')).map((e) => e.ts));
  const { result } = feedCell({ cell: built.cell, room: 'karaoke' }, 30);
  assert.notEqual(result.firstPathTs.occupancy, null, 'occupancy path must fire');
  const lead = lastDripJoin * 1000 - result.firstPathTs.occupancy;
  assert.ok(lead >= 1800000, `occupancy lead ${lead / 1000}s before last drip join, gate 1800s (lab: 5100s)`);
});
