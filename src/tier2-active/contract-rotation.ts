/**
 * Contract rotation, scoped anti-replay component (antiRea
 * 3.3.3, X33-07 scoped, under the X33-09 capture-pair
 * component).
 *
 * LICENSED CLAIM, verbatim (freeze SCOPE-333-FREEZE-2026-11-25
 * section 1.3): "Contract rotation invalidates captured decoy
 * routes replayed as plain scripts, on this twin".
 *
 * MEASURED BASIS (salvage trial 2026-11-24, twin contracts:
 * epoch A prefix /api/v2 with fields sku, priceTier, stockBand,
 * warehouseZone and keyField sku; epoch B prefix /api/v3 with
 * fields code, tier, band, zone and keyField code):
 *
 *   Replay target            Before rotation   After rotation
 *   Decoy routes as scripts  100%              0% (all steps 404)
 *   Real contract (control)  100%              100%
 *
 * SCOPE NOTE, which must always travel with the claim: this is
 * a component property of the decoy layer, NOT a candidate
 * pass, and it counts in no benchmark tally. The rotation
 * family's live-agent verdict remains KILL (v2) and is not
 * reopened by this component: a live agent re-reads the current
 * surface and finds the new contract; only a CAPTURED script,
 * replayed blind, dies.
 *
 * WHAT IT DOES. The decoy contract (prefix, routes, field
 * names, key field) is versioned by epoch. The host serves
 * only the current epoch's prefix and answers 404 for any
 * stale epoch's prefix - that 404 is the measured anti-replay
 * property. This module tracks the epoch state and classifies
 * paths; serving and 404-ing remain the host's job, driven by
 * `statusForPath`.
 *
 * CONTRACT.
 * - Construction throws on an empty contract list or an
 *   unknown `initialEpoch`; a rotation state that cannot name
 *   its current contract must not exist.
 * - `rotate` advances one epoch at a time and reports
 *   `rotated: false` at the last contract instead of wrapping:
 *   silently returning to an old epoch would resurrect every
 *   captured script that epoch ever leaked.
 * - `statusForPath`: "current" for the current prefix itself
 *   or any path under it; "stale" for any other epoch's
 *   prefix; "not-decoy" for everything else (real routes are
 *   never this module's business).
 */

export interface DecoyContractDescriptor {
  epoch: string;
  prefix: string;
  routes: string[];
  fields: string[];
  keyField: string;
}

export interface ContractRotationOptions {
  /** The epoch contracts, in rotation order. Must be non-empty. */
  contracts: DecoyContractDescriptor[];
  /** Epoch to start on. Default: the first contract's epoch. */
  initialEpoch?: string;
}

export type DecoyPathStatus = "current" | "stale" | "not-decoy";

export interface ContractRotation {
  /** The current epoch's contract descriptor. */
  current: () => DecoyContractDescriptor;
  /** The current epoch name. */
  epoch: () => string;
  /** Advance to the next contract; `rotated: false` when already at the last. */
  rotate: () => { rotated: boolean; current: DecoyContractDescriptor };
  /** Classify a path against the epoch prefixes. */
  statusForPath: (path: string) => DecoyPathStatus;
}

export class ContractRotationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractRotationError";
  }
}

const underPrefix = (path: string, prefix: string): boolean => path === prefix || path.startsWith(`${prefix}/`);

/** Create the contract rotation state. See the module header for the full contract. */
export function createContractRotation(opts: ContractRotationOptions): ContractRotation {
  if (!opts.contracts || opts.contracts.length === 0) {
    throw new ContractRotationError("createContractRotation: contracts must be a non-empty list");
  }
  const contracts = [...opts.contracts];
  // Prefix hygiene, structural: an empty prefix would classify
  // every absolute path as the current decoy contract, and two
  // epochs sharing one prefix would make the stale epoch
  // indistinguishable from the current one (the anti-replay
  // property presumes distinct prefixes). Reject at construction,
  // like the empty list and the unknown initialEpoch above.
  const seenPrefixes = new Set<string>();
  const seenEpochs = new Set<string>();
  for (const c of contracts) {
    if (typeof c.prefix !== "string" || c.prefix.length === 0 || !c.prefix.startsWith("/") || c.prefix.endsWith("/")) {
      throw new ContractRotationError(
        `createContractRotation: contract prefix must be a non-empty path prefix starting with "/" and not ending with "/" (epoch "${c.epoch}")`,
      );
    }
    if (seenPrefixes.has(c.prefix)) {
      throw new ContractRotationError(`createContractRotation: duplicate contract prefix "${c.prefix}"`);
    }
    if (seenEpochs.has(c.epoch)) {
      throw new ContractRotationError(`createContractRotation: duplicate contract epoch "${c.epoch}"`);
    }
    seenPrefixes.add(c.prefix);
    seenEpochs.add(c.epoch);
  }
  let index = 0;
  if (opts.initialEpoch !== undefined) {
    index = contracts.findIndex((c) => c.epoch === opts.initialEpoch);
    if (index < 0) {
      throw new ContractRotationError(`createContractRotation: unknown initialEpoch "${opts.initialEpoch}"`);
    }
  }

  const current = (): DecoyContractDescriptor => contracts[index] as DecoyContractDescriptor;

  return {
    current,
    epoch: () => current().epoch,
    rotate: () => {
      if (index >= contracts.length - 1) return { rotated: false, current: current() };
      index += 1;
      return { rotated: true, current: current() };
    },
    statusForPath: (path) => {
      if (typeof path !== "string") return "not-decoy";
      const cleanPath = path.split("?")[0] ?? path;
      if (underPrefix(cleanPath, current().prefix)) return "current";
      for (let i = 0; i < contracts.length; i++) {
        if (i === index) continue;
        const other = contracts[i] as DecoyContractDescriptor;
        if (underPrefix(cleanPath, other.prefix)) return "stale";
      }
      return "not-decoy";
    },
  };
}
