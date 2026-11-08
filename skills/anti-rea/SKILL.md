---
name: anti-rea
description: >-
  Integrate the antiRea npm library (@dannyphan190/anti-rea) into a host web application to detect and meter automated abuse: bot herds driven by a single scheduler, silent accounts squatting limited live-room seats, vote brigading, room enumeration, reconnect storms, slow per-identity data harvesting, and republication of derived data. Use when a developer reports bot swarms freezing a live room, seats held by silent accounts, rigged skip votes, crawling of rooms or member lists, or bulk dataset extraction. Every signal is advisory (enforcement: "none") - the host code decides the response, and step-up applies to new joins only.
license: MIT
compatibility: Requires Node.js >= 20 and the npm package @dannyphan190/anti-rea, wired server-side at the application layer. Examples are TypeScript; plain JavaScript works the same way.
metadata:
  version: "2.7.4"
  npm-package: "@dannyphan190/anti-rea"
  source-repository: "https://github.com/dankezo/antiRea"
---

# antiRea integration skill

You are wiring antiRea into a host application on behalf of a developer. antiRea is a server-side TypeScript library (Node >= 20, zero runtime dependencies) that measures coordinated automated abuse and meters dataset access; the host application decides what to do with its output. This skill covers antiRea 2.7.4.

Install:

```bash
npm install @dannyphan190/anti-rea
```

Read the ground rules first - they override any pattern you find elsewhere. Then find the developer's symptom in the decision tree, wire the matching module exactly as its section shows, and finish with the post-integration verification checklist.

## Ground rules (read before writing any code)

1. **Every antiRea signal is advisory.** Every result object carries `enforcement: "none"`. antiRea measures and reports; **your host code** decides what happens. There is no module in this package that blocks, bans, or throttles anyone by itself.
2. **Never hard-block on advisory output.** The strongest legitimate reaction to a signal is a *step-up* (an extra verification challenge) for **new** actions, wired through `createVerificationGrace`. A signal is evidence, not a verdict about a person.
3. **Never apply consequences to people already inside.** For live rooms specifically: members already in the room are never kicked, muted, or down-ranked because a room-level signal fired. Signals gate **new joins only**.
4. **Defaults are lab-frozen, not suggestions.** Thresholds in the modules below were fixed before the lab ran and validated against pre-registered false-positive budgets. Do not "tune" them silently. If a host's traffic differs, say so in the integration notes and keep the defaults until the host has its own measurements.
5. **All lab numbers are simulation numbers.** They were measured on seeded synthetic populations, not on the host's real traffic. Present them that way in any summary you write for the developer.
6. **antiRea works at the application layer.** It sees joins, actions, and serves - not packets. Network-layer volumetric DDoS is out of scope: that layer belongs to the hosting/CDN provider (e.g. Cloudflare). Do not promise DDoS protection from this package.

## Decision tree: symptom -> shape -> module

| What the developer reports | Likely shape | Reach for | Section |
|---|---|---|---|
| "Our live room crashes / freezes when bots swarm in" | Join flood at the application layer (hundreds of fresh accounts joining at once, then doing nothing) | Meter + step up **new joins** under pressure: `createVerificationGrace` `guardStepUp` driven by your own join-rate check; feed joins to `createHerdPhaseSignal` for the fleet picture | A, B |
| "The karaoke seats are always full of silent accounts" | Seat squatting: fresh accounts take limited seats and hold them with zero activity | `createSeatOccupancySignal` (one instance per room; step up **new** seat claims via Section B while it flags) | C, B |
| "Bots keep rejoining / retrying on a fixed rhythm" | One scheduler driving a fleet: joins/retries phase-locked to a shared timer | `createHerdPhaseSignal` | A |
| "A whole group of accounts moves like one machine, but no single account misbehaves" | One scheduler driving a cohort: the group's timing points pile onto one spot of the phase plane | `createHerdTightnessSignal` (needs a reference stream from established users; cohort-level evidence, names nobody) | H |
| "Chat / emotes arrive in machine-locked bursts" | A fleet that joined normally but acts on one shared scheduler | `createActivityPhaseSignal` on ONE activity stream, evaluated scoped | D |
| "Songs keep getting skip-voted by brand-new accounts" | Vote brigading: fresh accounts voting together, song after song | `createVoteBrigadingSignal` (room state; step up new voters while it flags) | E |
| "Something is crawling all our rooms / member lists" | Room enumeration: one account joining room after room | `createRoomHopSignal` (step up the named identities) | F |
| "The realtime server keeps dying and reviving at night" | Reconnect storm: sources cycling connect/disconnect at sub-second cadence | `createReconnectStormSignal` on your socket connect/disconnect hooks; enforce backoff host-side | G |
| "Accounts cycle join -> leave -> join constantly" | Churn against presence/connection limits | `createHerdPhaseSignal` on the join stream (the cycle is a repeated event), plus host-side join-rate metering | A |
| "One account has been quietly taking our data for weeks" | Slow per-identity harvesting | `createShrinkSlopeSignal`; accumulate with `createCusumTripwire` / `createEvalueTripwire` | - |
| "Accounts poll the same pages like metronomes" | Machine-paced revisiting | `createWatchlistSignal` | - |
| "Something is enumerating our ids / endpoints" | Enumeration walk | `createDecoyTripwire` (plant decoys outside every menu/sitemap/listing) | - |
| "Our published totals appear on a competitor's site" | Republication of derived data | `createValueWatermark` | - |
| "Users pile up just under our known limit" | Calibration against a ceiling | `createBunchingMonitor` | - |

### Honest note on the room guard that does not exist (read this before improvising)

A combined room-guard module (`createRoomGuard`) was designed for 2.7.3 and **deliberately not shipped**: in its pre-registered lab pin, the frozen signal combination caught join floods (60 s), slow drips (31 min) and churn (30 s) with zero false alarms across four legitimate room cells - but it **missed the seat-squatting cell completely**, because squatting attacks occupancy, not join velocity. Under this project's release rule (no gate loosened after the numbers), the module was excluded rather than shipped half-blind. **Do not invent a `createRoomGuard` API - it does not exist in this version.** The occupancy leg it lacked was afterwards re-registered as its own candidate, passed its own frozen lab pin, and ships as the standalone `createSeatOccupancySignal` (Section C) - the wave-2 modules are separate signals with separate contracts, not a guard under another name.

## Section A - `createHerdPhaseSignal` (new in 2.7.3)

Detects a fleet driven by **one shared scheduler**: identities whose repeated events (room joins, session starts, retries) lock onto the same 900-second grid **at the same offset**. The cohort statistic is the point: an identity locked to *its own* grid (a personal cron job, an independent bot) is common and is **not** flagged - only a shared offset confirms a herd.

```ts
import { createHerdPhaseSignal, HERD_PHASE_ROOM_COHORT_WINDOW_MS } from "@dannyphan190/anti-rea";

// One instance per room (or per surface). Do not mix unrelated
// populations into one instance - the cohort is the population
// you evaluate together.
const herd = createHerdPhaseSignal(); // all defaults are the lab-frozen law

// On every room join (or session start, or retry - pick ONE
// homogeneous event kind per instance and stay with it):
herd.observe({ identity: accountId, ts: Date.now() });

// Periodically (e.g. every 5 minutes), evaluate. For room joins,
// scope the cohort to identities first seen in the last 24 h -
// the scoping the roomguard pin validated:
const r = herd.evaluate({ cohortWindowMs: HERD_PHASE_ROOM_COHORT_WINDOW_MS });

if (r.confirmed) {
  // r.members names the fleet's identities - named ONLY because
  // the cohort confirmed. Treat this as evidence: feed your
  // accumulator, raise step-up for NEW joins, alert the operator.
  // Do NOT ban r.members on this output alone.
}
```

Contract details an agent must not get wrong:

- An identity needs **>= 8 events** before it is scored (`minEvents`). One-shot floods are invisible to this signal by construction - that shape belongs to metering, not here.
- `result.members` is **empty unless `result.confirmed` is true**. A large `result.memberCount` with `confirmed: false` means "many grid-locked identities, no shared scheduler" - the designed refusal, not a bug.
- `evaluate()` is a pure function of the fed state: same state, same result, byte for byte.
- The only lab-validated grid period is **900 s** (`periodSec` default). Changing it leaves the lab record behind.
- Malformed events never throw into your request path: a bad `ts` returns `{ status: "invalid_ts", counted: false }`. Bad *options* and a blank identity throw `HerdPhaseError` at setup/feed time - that is a programmer error, fix it, don't catch-and-ignore it in production paths.
- Memory is bounded (`maxIdentities` default 100,000, `maxEventsPerIdentity` default 4,096); watch `snapshot().counters` for evictions if your rooms are huge.

## Section B - Step up NEW joins under pressure (`createVerificationGrace`)

antiRea ships no combined room-pressure module in 2.7.3 (see the note above), but the reaction pattern for a join flood is standard and uses shipped pieces:

```ts
import { createVerificationGrace } from "@dannyphan190/anti-rea";

const grace = createVerificationGrace();

// When a visitor passes your step-up challenge (captcha, email
// code, ...), record it:
grace.recordVerified(accountId);

// At JOIN time, translate your own pressure reading (join rate
// vs this room's baseline, an accumulator score, ...) into an
// evidence level in YOUR units, and ask the grace module whether
// the step-up may be applied to this identity right now:
const verdict = grace.guardStepUp(accountId, evidenceLevel);
if (verdict.action === "step_up") {
  // Run your step-up challenge BEFORE completing the join.
  // "observe" means the identity is inside its post-verification
  // grace window - let the join through without re-challenging.
}
// Existing room members are never re-challenged by this pattern -
// it runs at join time only. Set `flagThreshold` (constructor
// option) to the evidence level that normally triggers step-up in
// your units; the module never invents an evidence scale.
```

Rules: the step-up applies to the **join attempt**, never retroactively to members; a failed or pending step-up delays a join, it does not ban the account; keep your room's normal (non-pressure) joins challenge-free - friction is for pressure moments only.

## Section C - `createSeatOccupancySignal` (new in 2.7.3)

Population-only room state for capacity-limited rooms: the share of seats held by accounts created < 24 h before joining that have shown **zero activity** since joining. It names no identity - a flag means "this room's seats are being held", never "this person is a bot". Two lab-frozen profiles: FAST (defaults) for burst squats, DRIP for slow seat-taking; run two instances if you want both.

```ts
import { createSeatOccupancySignal, SEAT_OCCUPANCY_DRIP_PROFILE } from "@dannyphan190/anti-rea";

// ONE instance per room; capacity is the room's real seat count.
const seats = createSeatOccupancySignal({ capacity: room.capacity });
const seatsDrip = createSeatOccupancySignal({ capacity: room.capacity, ...SEAT_OCCUPANCY_DRIP_PROFILE });

// Feed the room's seat lifecycle. accountCreatedTs whenever you
// have it; without it, first observation stands in.
seats.observe({ type: "join", identity: accountId, ts: Date.now(), accountCreatedTs });
seats.observe({ type: "activity", identity: accountId, ts: Date.now() }); // chat, emote, sing, react - any real activity
seats.observe({ type: "leave", identity: accountId, ts: Date.now() });

const r = seats.evaluate();
if (r.flagged) {
  // Room state, not a verdict on anyone seated: step up NEW seat
  // claims (Section B pattern), alert the operator. NEVER eject
  // current occupants because this fired.
}
```

Contract details: a first-time listener who never chats is normal - the lab's silent-audience cell (60% of seat sessions silent) peaked at 0.1333 against the 0.50 FAST line. The DRIP line (0.34 for a full hour) is closer to unusual-but-legit rooms; check `currentRatio` in the result before acting on a DRIP flag. If your app never emits an activity type, everyone looks idle - feed at least one real activity kind.

Field note (real site, inspected 2026-11-06): on wetube cine, joining a room auto-assigns a free seat and empty seats are backfilled with house bots that yield the moment a human picks their seat. If your app does anything similar, feed the signal the real seat lifecycle (join / activity / leave) for human accounts - house bots are your own population, not occupants.

## Section D - `createActivityPhaseSignal` (new in 2.7.3)

The herd-phase law (Section A) over an **activity** stream - for fleets that join like everyone else but chat/emote/react on one shared scheduler. Same options, same thresholds, same naming rule as `createHerdPhaseSignal`; only the factory name, the `kind` field and the notice differ.

```ts
import { createActivityPhaseSignal, ACTIVITY_PHASE_ROOM_COHORT_WINDOW_MS } from "@dannyphan190/anti-rea";

const actPhase = createActivityPhaseSignal();
// Feed ONE activity kind per instance (chat sends, say):
chatBus.on("message", (m) => actPhase.observe({ identity: m.accountId, ts: m.ts }));

// Evaluate SCOPED - this is part of the law, not a style choice:
const r = actPhase.evaluate({ cohortWindowMs: ACTIVITY_PHASE_ROOM_COHORT_WINDOW_MS });
```

Contract details an agent must not get wrong: **unscoped evaluation over the whole user base was measured NOT to confirm even a real shared herd** (the legitimate background dilutes R_cohort) - a silent unscoped result means "wrong evaluation", not "no fleet". A room reacting together to the same film moment is safe: that cell measured zero members, because content moments are not on a fixed 900 s grid. Everything in Section A's contract list applies unchanged.

One more dilution limit, measured in the 2.7.3 integration benchmark on a busy room stream: even the SCOPED read confirms only when the herd dominates the >= 8-event scored population. On a busy chat stream, legitimate chatters cross the 8-event floor in large numbers, R_cohort can peak well under the 0.80 bar (0.531 in the benchmark) and never confirm - while the member list still names exactly the herd (25/25, zero legitimate). On chat-like streams, treat `members` plus the R_cohort trend as the usable telemetry below confirmation; do not expect the join stream's clean confirmations there (legitimate users rarely reach 8 joins, so the join stream's scored population stays nearly pure).

## Section E - `createVoteBrigadingSignal` (new in 2.7.3)

Population-only room state for vote-driven rooms (skip votes, queue votes): evidence accumulates across 60-second windows and flags only when at least **two** windows contribute - one mass skip by first-time visitors (a streamer raid hating one song) measured a bigger single spike than a brigade makes, and cannot flag by construction.

```ts
import { createVoteBrigadingSignal } from "@dannyphan190/anti-rea";

const votes = createVoteBrigadingSignal(); // one instance per room
onSkipVote((v) => votes.observe({ identity: v.accountId, ts: v.ts, accountCreatedTs: v.accountCreatedTs }));

const r = votes.evaluate();
if (r.flagged) {
  // Step up NEW voters (Section B pattern) or weight votes from
  // accounts < 24 h old at zero until it clears. Do not cancel
  // the current song retroactively and never name voters - the
  // result contains no identities.
}
```

Contract details: measured scope is **vote-skip only** - queue stuffing was registered but not measured; do not claim it. Brigades voting from aged accounts are out of scope by construction (newness is the score's main leg).

Field note (real site, inspected 2026-11-06): wetube cine's skip rule is "30% of the people present ends the song", counted over real people only - house bots are excluded from the denominator - with one vote per account per video and click-again-to-withdraw. Real thresholds on this class of site are commonly a share of the real humans present, not a fixed count; the signal's job is unchanged: watch HOW the votes arrive (many brand-new accounts across several windows), not the threshold arithmetic itself.

## Section F - `createRoomHopSignal` (new in 2.7.3)

Per-identity enumeration shape: flags an identity joining **16+ distinct rooms in any trailing hour** (legit surfers measured at most 11). It carries a self-disarm: if more than 25% of tracked identities would flag, the result names nobody and reports `disarmed: true`. A disarm usually means "the platform changed or the feed is wrong" - but it can also engage during a genuine concentrated attack while the legitimate background is thin (at night, say): the 2.7.3 integration benchmark saw names emitted first, then the disarm flipping on as the evening background thinned. So: never act on names while `disarmed` (there are none), but DO alert a human when `disarmed: true` arrives with `flaggedCount > 0` - that combination is a population-level attack signal, not noise.

```ts
import { createRoomHopSignal } from "@dannyphan190/anti-rea";

const hops = createRoomHopSignal();
onRoomJoin((j) => hops.observe({ identity: j.accountId, room: j.roomId, ts: j.ts }));

const r = hops.evaluate();
if (!r.disarmed) {
  for (const id of r.flagged) {
    // Step-up friction for THIS identity (Section B pattern).
    // Never an automatic ban: breadth is evidence, not proof.
  }
}
```

Contract details: never key this by IP - carrier NAT makes shared IPs meaningless; the verdict is per-identity breadth over its own joins. If your platform's discovery UI encourages much heavier surfing than the lab populations, re-derive `threshold` from your own legit maximum with margin.

## Section G - `createReconnectStormSignal` (new in 2.7.3)

Per-source reconnect abuse over your socket layer's app-level connect/disconnect hooks: flags a source with **40+ connects in 10 minutes whose sessions median under 5 seconds**. Flaky phones (13) and train commuters (21) measured well under the rate leg. Same 25% self-disarm as Section F - a bad deploy that makes every client flap SHOULD disarm it; that is the platform telling on itself. The same disarm can also cover a genuine concentrated storm at night: in the 2.7.3 integration benchmark the raw law flagged 20/20 storm sources, but `disarmed` stayed true for the storm's whole duration (at 22:45 almost nobody legitimate is connecting, so the flagged share sits over 25%) and the named list stayed empty. Wire your alerting on `disarmed: true` WITH `flaggedCount > 0`, not only on named flags - a host that reads only `flagged` is blind exactly during a concentrated night storm.

```ts
import { createReconnectStormSignal } from "@dannyphan190/anti-rea";

const storms = createReconnectStormSignal();
io.on("connection", (socket) => {
  const source = socket.data.sessionKey; // session/account key - NOT socket.handshake.address
  storms.observe({ source, kind: "connect", ts: Date.now() });
  socket.on("disconnect", () => storms.observe({ source, kind: "disconnect", ts: Date.now() }));
});

const r = storms.evaluate();
if (!r.disarmed) {
  for (const src of r.flagged) {
    // Enforce reconnect backoff / step-up for this source.
    // Friction, never punishment of the source's user.
  }
}
```

Contract details: **never use an IP as the source key**. Known blind spot, stated plainly: a storm spread thin across many sources (each under 40/10 min) flags nobody - there is deliberately no population gate, because legitimate rush-hour commutes reach 417 connects/10 min in aggregate. Distributed storms belong to socket-layer rate limits, not this signal.

Field note (real site, inspected 2026-11-06): wetube cine's own room rules give a dropped connection up to **2 minutes** to reconnect before the seat is lost. Hosts commonly hold a seat through a grace window like this, so legitimate reconnects legitimately cluster inside it - that is exactly the flaky-client population the rate leg was calibrated to stay clear of.

## Section H - `createHerdTightnessSignal` (new in 2.7.4)

The companion statistic to Section A, one level up: where herd-phase asks whether a fleet's members share one timer *offset*, herd-tightness asks whether a whole cohort's timing points pile onto **one spot** of the phase plane - the shape one scheduler leaves on a group all at once. Each identity with >= 8 events becomes one point (its mean phase vector on the 900 s grid); the module measures how spread out the cohort's cloud of points is (the longest minimum-spanning-tree edge, d0max), standardised against a **reference population you feed it** - your established, known-legitimate users. A shared-scheduler herd reads tight (lab: 0.26-0.28 against the frozen bar 0.81); ordinary users (1.09-1.36) and an office-hours group behind one NAT (1.39-1.72) read spread.

```ts
import { createHerdTightnessSignal } from "@dannyphan190/anti-rea";

const tightness = createHerdTightnessSignal(); // defaults are the lab-frozen law

// Feed your established legitimate population as the reference
// (long-lived accounts, known-good traffic - the standardisation
// baseline), and the population under watch as the cohort. One
// homogeneous stream each: session starts OR room joins.
tightness.observeReference({ identity: establishedAccountId, ts });
tightness.observe({ identity: accountId, ts });

const r = tightness.evaluate();
if (r.status === "scored" && r.tight) {
  // Cohort-level evidence that this group is driven by one
  // scheduler. Feed it to your accumulator / human review.
  // r names NO identity - there is nobody to step up from this
  // signal alone; pair it with Section A to find the members.
}
```

Contract details: **the output never names an identity** - tightness is a property of a cloud, and any wiring that turns it into a per-account action is a misuse. Without a scored reference population the module returns `status: "uncalibrated"` with `tight: null` - wire your alerting to treat that as "not wired yet", never as "not tight". A herd whose bots each keep their **own** timer offset reads spread and is not flagged (that shape is Section A's cohort leg); the two signals are companions, not substitutes. Evaluate is O(n^2) in scored identities - this is a small-cohort instrument (the lab clouds were 9-16 points), not a fleet-wide scan.

## Safe defaults (do not retune silently)

| Module | Option | Default | Why |
|---|---|---|---|
| `createHerdPhaseSignal` | `periodSec` | 900 | Only lab-validated scheduler grid |
| | `memberThreshold` (tau_R) | 0.90 | Frozen in the measured gap (legit p99 0.6495, herd p05 0.9616 in the lab) |
| | `cohortThreshold` (tau_C) | 0.80 | Frozen between the shared (~0.98) and independent (~0.10) regimes |
| | `minEvents` | 8 | Lab scoring floor |
| | `minMembers` | 10 | Lab confirmation floor |
| | `cohortWindowMs` (evaluate) | 86,400,000 (24 h) for room joins | Scoping validated by the roomguard pin |
| `createSeatOccupancySignal` | `threshold` / `sustainMs` | 0.50 / 600,000 (FAST) | Frozen in the CAND-273-1 pin (legit peak 0.1333, squat flagged 660 s) |
| | DRIP profile | 0.34 / 3,600,000 | Frozen in the CAND-273-2 pin; narrower margin - check `currentRatio` before acting |
| `createActivityPhaseSignal` | (all) | Same as herd-phase | The law is inherited, not re-tuned; scoping is mandatory (Section D) |
| `createVoteBrigadingSignal` | `threshold` / `minWindows` | 12 / 2 | Frozen in the CAND-273-4 pin; the 2-window rule is what a one-off raid cannot pass |
| `createRoomHopSignal` | `threshold` / `windowMs` | 16 / 3,600,000 | Frozen in the CAND-273-5 pin (heavy legit max 11/hour) |
| | `disarmShare` | 0.25 | C35-pattern insurance; lowering it mutes the signal, raising it risks mass flags |
| `createReconnectStormSignal` | `minConnects` / `maxMedianDurationMs` | 40 / 5,000 | Frozen in the CAND-273-6 pin (legit max 21/10 min) |
| `createHerdTightnessSignal` | `periodSec` | 900 | Only lab-validated scheduler grid |
| | `tightnessBar` | 0.805436 | Frozen C148 calibration midpoint (herd bootstrap max 0.645, legit bootstrap min 0.965); recalibrate only against your own reference population, with the recalibration recorded |
| | `minEvents` / `minIdentities` | 8 / 8 | Lab scoring floor / lab cloud floor (below 8 scored identities the lab voided the reading) |

## Never do this

- Never ban, kick, or shadow-limit an account or a room member **solely** because an advisory signal fired - including a confirmed herd-phase cohort.
- Never re-challenge or eject **existing room members** when a room-level signal fires. New joins only.
- Never lower `memberThreshold` / `cohortThreshold` / `minMembers` to "catch more" - you are spending a false-positive budget that was measured for you; the lab's legitimate groups (office-hours fleets, sale bursts) sit closer to the line than intuition suggests.
- Never feed mixed event kinds (joins + chats + clicks) into one herd-phase instance; phases only mean something on one homogeneous stream.
- Never evaluate `createActivityPhaseSignal` (or herd-phase over a huge base) over an unscoped whole-platform population and report its silence as coverage - unscoped dilution is measured, and scoped evaluation is part of the law.
- Never use an IP address as the identity/source key for room-hop or reconnect-storm - carrier NAT shares IPs across strangers; both signals are per-identity by design.
- Never act on a room-hop or reconnect-storm result when `disarmed` is true - the disarm means the platform or the feed changed shape; investigate first.
- Never eject or punish current room occupants because a population signal (seat-occupancy, vote-brigading) flagged the room - those outputs name no one and accuse no one.
- Never present lab numbers as real-traffic performance in a summary, README, or sales copy.
- Never claim this package stops network DDoS. It does not see packets.
- Never invent APIs. If a function is not in `dist/index.d.ts`, it does not exist - in particular, **there is no `createRoomGuard` in 2.7.3**.

## Post-integration verification checklist

Run through this before reporting the integration done:

- [ ] `npm run build` (or the host's build) passes with the new wiring; no antiRea import reaches the default request path unless intended - signals are opt-in.
- [ ] A synthetic shared-grid herd (12 joins per identity on a 900 s grid, ~30 s jitter, 12+ identities) fed to `createHerdPhaseSignal` in a test returns `confirmed: true` and names the members.
- [ ] The same herd with a **different random offset per identity** returns `confirmed: false` and `members: []`.
- [ ] Ordinary traffic shapes (steady joins, a 50-user raid after a link drop, a scheduled showtime join) produce **no** confirmation and **no** step-ups beyond your intended pressure rule.
- [ ] Step-up (Section B) triggers only on join attempts during pressure, and a member already in the room can keep watching/chatting uninterrupted while it is active.
- [ ] A synthetic squat (16+ fresh silent joins into a 30-seat room, no activity) fed to `createSeatOccupancySignal` in a test flags after the 600 s sustain, and the same stream with the joiners chatting does not.
- [ ] Room-hop / reconnect-storm wiring keys on identity/session keys (never IPs), and your code checks `disarmed` before reading `flagged`.
- [ ] `snapshot()` counters on each instance show no unexpected `invalidTs` growth (that means your timestamps are malformed somewhere upstream).
- [ ] Your summary to the developer states plainly: which signals are wired, that all are advisory (`enforcement: "none"`), what enforcement the *host code* performs, and that the combined `createRoomGuard` does **not** exist in this version.
