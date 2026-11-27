# Escalating VDF Ladder (HV-01 x HV-02) - Opt-In Module

Module: `src/tier2-active/vdf-ladder.ts`
Status: OPT-IN, default OFF. Nothing in the SDK enables this module
for you; a host wires it to its own export path explicitly.
Scope and claim basis: `SCOPE-333-FREEZE-2026-11-25.md` sections
1.5, 2.1.4, 2.2 and 4.3; measured basis:
`HV-COMPOSITE-TRIAL-REPORT-2026-11-25.md` (composite trial,
2026-11-25).

## What it is

A time-tax gate for a bulk / export path, built from a Wesolowski
verifiable delay function (VDF) over an RSA-2048 group.

- The host serves its export in batches. Batch sizing is the
  host's policy: the trial used batches of 50 records, so a
  2,000-record catalog is 40 batches, and this module prices one
  gate per batch served. Paying gate k releases batch k; there
  is no lookahead - only the next gate's challenge is ever
  issued.
- Gate k costs T_k sequential squarings, escalating geometrically:

  T_k = floor(300000 x 116^(k-1) / 100^(k-1)), k = 1..40

  T_1 = 300,000; T_7 = 730,918; T_40 = 97,945,127; the full table
  sums to 708,227,155 squarings.
- The client proves each gate with a Wesolowski proof whose
  challenge prime is derived Fiat-Shamir style from
  (x, y, T, serial, gate). Server verification is a pair of
  modular exponentiations - milliseconds, against seconds to
  minutes of client delay.
- Ladder state is keyed ONLY by the SHA-256 hash of a random
  serial inside a Chaum blind-signed token (Privacy Pass style).
  Cookies, accounts, IP addresses and user agents play no part
  in the ladder at all: the challenge, redeem and status
  operations take only the token. Resetting the whole identity
  layer therefore cannot reset the ladder - a client that keeps
  its token resumes at the gate it had reached. This is a
  structural property of the design, not a configuration option.

## Measured lab basis (standalone numbers, with the freeze section 1.5 caveat)

These are measurements of THIS mechanism alone, on the trial's
lab twin, and they may only be quoted as such, with the caveat
below attached:

- A full 2,000-record harvest through the gated export path
  (40 gates, one token, native-speed evaluator) took 1,456.48 s
  wall-clock.
- A normal legitimate export session (3 batches, desktop
  Chromium with a WASM evaluator) added 7.26 s in total; the
  largest single gate in that session was 2.79 s.
- Independent cross-check (2026-11-27 bench, T = 300,000 x
  1.16 ladder wired across the full request path of two lab
  apps): the 3 gates added 13.50 s (catalog) and 13.29 s (SPA)
  of client compute for legitimate sessions. Hosts must budget
  real user time, not just attacker time: at this ladder
  setting the legit cost is on the order of ten-plus seconds
  per gated flow, and the same run measured the attacker's
  total cost at only ~1.1x the ungated baseline — below the
  registered cost bars. See
  `docs/evidence/independent-bench-3.3.3-2026-11-27.md`.
- Server-side proof verification median was 0.404 ms under
  parallel load.
- After paying 6 gates and resetting the entire identity layer
  while keeping the token, the next challenge was gate 7 at
  T_7 = 730,918 - the frozen table value, not T_1.
- Negative controls held in the trial: no token returns 401, a
  forged signature returns 401, a replayed proof returns 403,
  and a second token issue for the same device in one epoch
  returns 429.

CAVEAT (freeze section 1.5, part of the measurement, not a
footnote): the anti-reset strength of this mechanism rests
entirely on the scarcity of token issuance, and that scarcity
was ASSUMED in the lab construct, not measured. The lab issuer
enforced at most 1 token per device id per epoch; production
scarcity requires platform attestation (for example Apple PAT /
Privacy Pass), whose coverage outside Apple is thin. No claim is
made here for attestation integration, for token scarcity
outside the lab, for mobile timing, or for any composite cost
figure: the ladder's seconds must never be added to any other
mechanism's cost, and the ladder must never be described as
multiplying the cost of the 3.3.3 stack as a whole by any
factor. It was measured standalone, on the export path only.

## Wiring sketch

1. Generate two SEPARATE RSA-2048 keypairs with
   `generateVdfGroup()`: one for the VDF group (modulus N,
   generator g = 2) and one for the token issuer. The trial kept
   these roles separate; do not merge them into one key. Keep
   both private halves secret - factoring the VDF modulus
   shortcuts the delay, and the issuer's private key mints
   tokens.
2. Issue tokens with `createVdfTokenIssuer` (server side) and
   `createVdfTokenClient` (client side) using the blind flow:
   the client blinds its serial, the issuer signs the blinded
   value subject to the per-device per-epoch cap, the client
   unblinds. The wire form is the token header
   `<serial hex>:<signature decimal>`.
3. Create the ladder with `createVdfLadder`, passing the VDF
   group, the issuer's `verifyToken`, a `LadderStore` (an
   in-memory store ships with the module; multi-instance hosts
   supply their own store over the same entry shape), and an
   `onGatePaid(serialHash, gate)` hook that releases the host's
   next batch.
4. Gate the export endpoint: challenge before serving a batch,
   redeem the client's proof to release it, status for display.

## DEGRADED MODE (deployments without platform attestation)

Freeze section 4.3 requires this mode to be documented, and it
is part of the shipped behavior, not an edge case.

Where a deployment has no platform attestation (no Apple PAT /
Privacy Pass issuer to enforce token scarcity), the issuer binds
tokens to a host-supplied device identifier instead: at most
`maxTokensPerDevicePerEpoch` tokens (default 1) are minted per
device identifier per epoch, and the ladder is keyed to the
token issued under that binding.

This is weaker than the lab construct's assumption, in exactly
one stated way: the binding is only as strong as the device
identifier the host supplies, and a client controls what it
presents. A client that presents a NEW device identifier
receives a new token and restarts the ladder at tier 1
(T_1 = 300,000). Equivalently: an identity or device change
resets the ladder. The escalating cost then taxes each
presented identity's export volume, but it does not tax a
client that rotates identifiers faster than it climbs.

The module stays opt-in. Enabling it in degraded mode means
accepting exactly this documented limit: per-identity export
taxation without attestation-grade reset resistance. This
documentation does not overstate freeze section 2.1.4 - the
standalone lab numbers above were measured under the lab's
issuance rule, and no production scarcity, attestation or
reset-resistance claim beyond this paragraph is made for
degraded deployments.

## Mobile calibration note

The composite numbers above were measured on desktop Chromium.
WASM evaluation on a weak mobile device can be several times
slower, and the 10 s per gate legitimate-user cap used in the
trial can break at the early tiers on such hardware. Mobile
timing is UNMEASURED. Hosts must re-measure evaluation time on
their own target devices before fixing production T parameters;
do not ship the frozen table as production parameters for
mobile clients on the strength of the desktop numbers.

## Power-user default behavior

A legitimate power user who exports the full 40 batches climbs
the SAME ladder as any other client: the final gate costs
approximately 192 s at the trial's calibration. That is the
documented default behavior of the mechanism - a tax
proportional to volume - not a silent false positive, and this
module contains no built-in exemption for it.

Hosts with contracted bulk customers should exempt them
host-side, as an explicit policy decision: either pass an
`isExempt` predicate to `createVdfLadder` (keyed by the token's
serial hash; an exempt token's challenge returns
`{ status: 200, exempt: true, gatesPaid: 0 }` and writes no
ladder state), or serve contracted bulk through a separate
export path under the host's own quota. Which customers are
exempt, and on what terms, is the host's documented policy
decision - the module deliberately ships no default answer.
