/**
 * Cohort evidence for feature abuse + canary actions.
 *
 * The action budget (`action-budget.ts`) meters what ONE identity may
 * spend; this tracker watches the dimension a per-identity budget
 * cannot see - what a GROUP of identities' actions COVER, in aggregate.
 * It is the herd detector's two grouping mechanisms transposed from
 * the record space to the action target space (export -> the exported
 * slice id, search -> the corpus slice a query range covers,
 * promo_claim -> the promo id, generic -> the endpoint id):
 *
 * - **complement**: identities whose target sets over the same action
 *   class are near-disjoint and whose union coverage is large - the
 *   herd transposed: disjoint slices of one export space, disjoint
 *   ranges of one corpus. Grouping is LEADER-BASED, as in herd v2:
 *   an identity's cluster is compared against other clusters'
 *   AGGREGATES (one target refcount map per cluster), never against
 *   every other identity, and there is no per-pair state. An identity
 *   joins a cluster only if, after adding its targets, the cluster's
 *   overlap ratio (1 - distinctTargets / totalTargetInstances) stays
 *   at or below `linkOverlapCeiling` (0.10 by default); if no cluster
 *   accepts it, it starts a new one. Only identities active inside
 *   the trailing window (`windowMs`, 15 minutes by default) count.
 *
 * - **shared-target**: identities converging on the SAME targetKey
 *   (one promo, one endpoint) - the farming shape, where target sets
 *   are identical, not complementary. Complement grouping correctly
 *   refuses to merge them (their overlap ratio is maximal); this
 *   mechanism counts distinct subjects and aggregate cost per target.
 *
 * The dilution gate is the feature-side shape definition: a
 * complement flag requires that at least 60% of the group's members
 * are individually AT OR BELOW their subject allowance in the
 * trailing window (allowance via `getAllowance`, else
 * `subjectAllowance`, default 100; window cost is accumulated by the
 * tracker itself from the events it is fed). The group is dangerous
 * precisely because no member is; a group whose members are
 * individually over their allowances (a small heavy team) does NOT
 * complement-flag - per-subject budgets govern it. Shared-target
 * flags do not require dilution: a promo pool is drained by claims
 * that are each individually lawful.
 *
 * Flag floors are the shipped defaults (host-configurable, fixed for
 * the classic round): complement needs >= 8 members, >= 100 aggregate
 * cost and >= 10 distinct union targets; shared-target needs >= 6
 * distinct subjects on one target and >= 100 aggregate cost.
 * Materiality is 1/12 of the flag floor per dimension, rounded up
 * (minimum 1), the herd law's derivation. For supplementary
 * re-announcement it stays cost-or-unique, as before. For friction
 * targeting (`actionFrictionTargets`) it is mechanism-dependent
 * (FEATURE-FIX-AMENDMENT Fix B, transposing the herd detector's
 * unique-coverage law): a complement member is a target only on
 * UNIQUE target contribution (targets nobody else in the group
 * holds), never on raw cost alone - a member whose every target is
 * duplicated by others gets zero friction however much it spent -
 * while a shared-target member, whose contribution is volume on one
 * shared target, stays cost-based. A flagged group
 * RE-ANNOUNCES itself (supplementary snapshot, coalesced at one per
 * 5 s per group, herd discipline) when a member who was not yet
 * announced with material contribution - a late joiner, or a pending
 * partial contributor - crosses materiality. Members announced with
 * exactly zero contribution are settled-inactive and never
 * re-trigger one on their own. `actionFrictionTargets` keeps only
 * members with material contribution MINUS protected members -
 * bystanders inside a flagged group get zero friction, as on the
 * data side. Protected subjects (host-declared, via `isProtected`)
 * accrue full telemetry, are listed under `protectedMembers`, and
 * are excluded from friction targets.
 *
 * Canary actions: the host registers targetKeys no legitimate UI
 * ever emits (`createCanaryActionRegistry` - an export slice that is
 * never linked, a promo id that is never shown). A touch is DIRECT
 * per-subject evidence: the tracker records a taint for the touching
 * subject only. Taints never splash onto other subjects, and a
 * protected subject's own canary hit still taints that subject (a
 * declaration is not a laundering lane). While a taint is live (the
 * tracker's activity window), the tainted subject appears in the
 * `taintedMembers` of any snapshot flagging on the same action class
 * when it is a member of the group or its targets intersect the
 * group's targets - so rotation into a fresh identity stops
 * resetting the clock at the first canary touch. Attribution comes
 * from the authenticated subject on the request, so a canary target
 * cannot be used to frame another subject: the touch is recorded
 * against whoever touched it.
 *
 * IP is recorded on events but is NEVER a grouping key: identities
 * sharing only an IP, with unrelated actions/targets, never group
 * and never flag (unit-tested invariant, as on the data side).
 *
 * Like the herd detector, this module never blocks, bans or alters a
 * response; it emits `onFlag` snapshots and the host decides the
 * consequence - for inferred cohorts, through the tiering clamp in
 * `enforcement-tiering.ts` / `clampActionStepDown`. State is
 * in-memory and bounded by the activity window. All lab clients for
 * this layer are scripted: flags prove the mechanics against those
 * shapes, not detection rates against adaptive agents.
 */

/* ------------------------------------------------------------------------ */
/* Canary action registry                                                    */
/* ------------------------------------------------------------------------ */

export interface CanaryActionTarget {
  action: string;
  targetKey: string;
  label?: string;
}

export interface CanaryActionRegistry {
  registerCanaryTarget(target: CanaryActionTarget): void;
  isCanaryTarget(action: string, targetKey: string): boolean;
  /** True when the event touches a registered canary target. */
  checkAction(event: { action: string; targetKey?: string }): boolean;
  list(): CanaryActionTarget[];
}

export function createCanaryActionRegistry(): CanaryActionRegistry {
  const targets = new Map<string, CanaryActionTarget>();
  const keyOf = (action: string, targetKey: string): string => `${action}\0${targetKey}`;
  return {
    registerCanaryTarget(target) {
      targets.set(keyOf(target.action, target.targetKey), { ...target });
    },
    isCanaryTarget(action, targetKey) {
      return targets.has(keyOf(action, targetKey));
    },
    checkAction(event) {
      return event.targetKey !== undefined && targets.has(keyOf(event.action, event.targetKey));
    },
    list() {
      return [...targets.values()].map(target => ({ ...target }));
    },
  };
}

/* ------------------------------------------------------------------------ */
/* Tracker                                                                   */
/* ------------------------------------------------------------------------ */

export interface ActionEvent {
  /** The authenticated identity key (same form the budgets use, e.g. `account:<id>`). */
  subject: string;
  /** Price-table key / action class (export, search, promo_claim, ...). */
  action: string;
  /** The action's target (slice id, promo id, endpoint id, ...). */
  targetKey?: string;
  /** Charged cost, fed by the host (e.g. from the action budget). Default 0. */
  cost?: number;
  /** Recorded, NEVER a grouping key. */
  ip?: string;
  /** Event time in ms since epoch. Defaults to the tracker clock (`now` option, else `Date.now`). */
  ts?: number;
}

export type ActionCohortMechanism = "complement" | "shared-target";

export interface ActionCohortFlagSnapshot {
  groupId: number;
  mechanism: ActionCohortMechanism;
  /** Member identity keys at flag time. */
  members: string[];
  /** Aggregate action cost each member contributed to this group in the window. */
  memberCost: Record<string, number>;
  /** Distinct targets each member holds in this group. */
  memberTargetCounts: Record<string, number>;
  /**
   * Distinct targets ONLY that member holds in this group (refcount
   * exactly 1). Beyond the spec'd snapshot fields: friction targeting
   * needs unique contribution, and - as with the herd detector's
   * `memberUniqueCoverage` - the snapshot carries it rather than
   * letting hosts guess it from distinct counts.
   */
  memberUniqueTargetCounts: Record<string, number>;
  /** Summed member cost in the window. */
  aggregateCost: number;
  /** Distinct targets in the group's union (1 for a shared-target group). */
  targetCoverage: number;
  /** Subjects with a live canary taint on this action class, merged per the header. */
  taintedMembers: string[];
  /** Members covered by the host's protected declaration at flag time. */
  protectedMembers: string[];
  /** True on a supplementary re-announcement for a late / newly material member. */
  supplementary?: boolean;
  /** ISO-8601 timestamp from the tracker clock. */
  timestamp: string;
}

export interface ActionTaint {
  subject: string;
  action: string;
  targetKey: string;
  ts: number;
}

export interface ActionCohortTrackerOptions {
  /** Fired on every flag (initial and supplementary). Errors are swallowed, as in the herd detector. */
  onFlag?: (snapshot: ActionCohortFlagSnapshot) => Promise<void> | void;
  /** Clock override (ms since epoch), mainly for tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Trailing activity window: only identities active inside it group, and taints live for it. Default 900_000 (15 min). */
  windowMs?: number;
  /** Complement join gate: maximum cluster overlap ratio after adding an identity. Default 0.10. */
  linkOverlapCeiling?: number;
  /** Complement flag floor: minimum members. Default 8. */
  flagMinMembers?: number;
  /** Flag floor: minimum aggregate cost (both mechanisms). Default 100. */
  flagAggregateCost?: number;
  /** Complement flag floor: minimum union distinct targets. Default 10. */
  flagTargetCoverage?: number;
  /** Shared-target flag floor: minimum distinct subjects on one target. Default 6. */
  sharedTargetMinSubjects?: number;
  /** Shared-target flag floor: minimum aggregate cost. Defaults to `flagAggregateCost`. */
  sharedTargetAggregateCost?: number;
  /** Fallback per-subject allowance for the dilution gate. Default 100. */
  subjectAllowance?: number;
  /** Resolve a subject's allowance for the dilution gate; takes precedence over `subjectAllowance`. */
  getAllowance?: (subject: string) => number | undefined;
  /** Host-declared protected subjects: full telemetry, zero friction targeting. */
  isProtected?: (subject: string) => boolean;
  /** Canary registry whose targets taint their toucher. */
  canaryRegistry?: CanaryActionRegistry;
  /** Alternative canary predicate (consulted alongside `canaryRegistry`). */
  isCanaryTarget?: (action: string, targetKey: string) => boolean;
  /** Coalescing window for supplementary re-announcements. Default 5_000. */
  supplementaryCooldownMs?: number;
}

export interface ActionCohortObservation {
  /** False when the event carried no usable subject/action and nothing was recorded. */
  recorded: boolean;
  /** The flag this event caused, when it caused one. (All flags also go to `onFlag`.) */
  flag?: ActionCohortFlagSnapshot;
}

/**
 * Event shape accepted by `evaluateAction`: the `observe` event
 * (`ActionEvent`), with `subjectKey` accepted as an alias for
 * `subject` for hosts that name the identity key that way.
 */
export interface ActionEvaluationEvent {
  subject?: string;
  subjectKey?: string;
  action: string;
  targetKey?: string;
  cost?: number;
  ip?: string;
  ts?: number;
}

export interface ActionCohortEvaluationCluster {
  groupId: number;
  mechanism: "complement";
  /** True when the cluster has a live flag (the same `flagged` state snapshots and `groups()` report). */
  flagged: boolean;
  /** True when the evaluated event would join this cluster under the observe-time link logic. */
  wouldJoin: boolean;
  /**
   * True when the event's targetKey already exists in this cluster's
   * target refcount - i.e. the destination is one the cluster has
   * already touched, whoever touched it. False for a destination new
   * to the cluster, and false when the event carries no targetKey.
   * A host's attempt-time join threat is a join toward an UNKNOWN
   * target: a subject re-touching a known target adds no coverage.
   */
  targetKnown: boolean;
}

export interface ActionCohortEvaluationSharedTarget {
  action: string;
  targetKey: string;
  /** True when the shared-target group has a live flag. */
  flagged: boolean;
  /** Distinct subjects currently in the shared-target group. */
  subjectCount: number;
}

export interface ActionCohortEvaluation {
  /** Every complement cluster of the event's action, each with its live flag state and join verdict. */
  clusters: ActionCohortEvaluationCluster[];
  /** The shared-target group the event's (action, targetKey) matches, when one exists. */
  sharedTargets: ActionCohortEvaluationSharedTarget[];
}

export interface ActionGroupInfo {
  groupId: number;
  mechanism: ActionCohortMechanism;
  action: string;
  /** The shared target, for shared-target groups. */
  targetKey?: string;
  members: string[];
  aggregateCost: number;
  targetCoverage: number;
  flagged: boolean;
}

export interface ActionCohortTracker {
  /** Record one action event and update grouping/flagging incrementally. */
  observe(event: ActionEvent): ActionCohortObservation;
  /**
   * Attempt-time evaluation (FEATURE-FIX-AMENDMENT Fix A): would this
   * event join a complement cluster, and is that cluster already
   * flagged - and does it touch an already-flagged shared target?
   * Each cluster entry also reports `targetKnown`: whether the
   * event's target is already in that cluster's refcount, so a host
   * can tell a coverage-extending join (new target) from a re-touch
   * of a target the cluster already holds. PURE: records nothing,
   * mutates no state, fires no `onFlag`, and records no canary taint,
   * so a host may call it BEFORE serving the action and repeat the
   * call freely.
   */
  evaluateAction(event: ActionEvaluationEvent): ActionCohortEvaluation;
  /** Diagnostic listing of current groups (complement clusters and shared-target groups). */
  groups(): ActionGroupInfo[];
  /** Clear one subject (and its group memberships and taints), or all tracker state when called with no argument. */
  reset(subject?: string): void;
  /** Live canary taints (inside the activity window), for host/test inspection. */
  taints(): ActionTaint[];
  /** `actionFrictionTargets` bound to this tracker's configured flag floors. */
  actionFrictionTargets(
    snapshot: ActionCohortFlagSnapshot,
    opts?: ActionFrictionTargetOptions,
  ): string[];
}

export interface ActionFrictionTargetOptions {
  /** Aggregate-cost flag floor the snapshot was raised under. Default 100. */
  flagAggregateCost?: number;
  /** Target-coverage flag floor the snapshot was raised under. Default 10. */
  flagTargetCoverage?: number;
  /** Explicit materiality floors, overriding the 1/12 derivation. */
  minCost?: number;
  minUniqueTargets?: number;
}

/**
 * The members of an action-cohort flag that friction may actually
 * target, MINUS protected members. Materiality is mechanism-dependent
 * (FEATURE-FIX-AMENDMENT Fix B; the flag floors come from `opts` -
 * the snapshot itself carries no flag-floor fields, and the
 * tracker-bound form injects the tracker's configured floors, so the
 * signature is unchanged):
 *
 * - `complement`: UNIQUE targets only - a member is a target only
 *   when its unique target contribution (`memberUniqueTargetCounts`:
 *   targets nobody else in the group holds) is at or above 1/12 of
 *   the coverage flag floor (rounded up, minimum 1). Raw cost no
 *   longer qualifies a complement member on its own: a member whose
 *   every target is duplicated by others (unique 0) gets zero
 *   friction however much it spent - the herd detector's
 *   `memberUniqueCoverage` law transposed to targets. Snapshots
 *   produced before `memberUniqueTargetCounts` existed fall back to
 *   distinct target counts.
 * - `shared-target` (also accepted spelled `shared_target`):
 *   cost only - a member is a target when its cost is at or above
 *   1/12 of the aggregate flag floor (rounded up, minimum 1), since
 *   its contribution is volume on the one shared target.
 *
 * Snapshots with any other (legacy/unknown) mechanism keep the
 * previous cost-or-unique rule. Bystanders inside a flagged group
 * get zero friction.
 */
export function actionFrictionTargets(
  snapshot: ActionCohortFlagSnapshot,
  opts: ActionFrictionTargetOptions = {},
): string[] {
  const costFloor =
    opts.minCost ?? Math.max(1, Math.ceil((opts.flagAggregateCost ?? 100) / 12));
  const uniqueFloor =
    opts.minUniqueTargets ?? Math.max(1, Math.ceil((opts.flagTargetCoverage ?? 10) / 12));
  const protectedSet = new Set(snapshot.protectedMembers ?? []);
  const uniqueCounts = (
    snapshot as { memberUniqueTargetCounts?: Record<string, number> }
  ).memberUniqueTargetCounts;
  const mechanism = snapshot.mechanism as string;
  return snapshot.members.filter(member => {
    if (protectedSet.has(member)) return false;
    const cost = snapshot.memberCost[member] ?? 0;
    const unique = uniqueCounts ? (uniqueCounts[member] ?? 0) : (snapshot.memberTargetCounts[member] ?? 0);
    if (mechanism === "complement") return unique >= uniqueFloor;
    if (mechanism === "shared-target" || mechanism === "shared_target") return cost >= costFloor;
    return cost >= costFloor || unique >= uniqueFloor;
  });
}

/* ------------------------------------------------------------------------ */
/* Internals                                                                 */
/* ------------------------------------------------------------------------ */

interface MemberEvent {
  targetKey: string;
  cost: number;
  ts: number;
}

interface MemberData {
  subject: string;
  events: MemberEvent[];
  /** Distinct target -> instance count, derived from `events`. */
  targets: Map<string, number>;
  /** Summed event cost, derived from `events`. */
  cost: number;
}

interface AnnouncedState {
  cost: number;
  unique: number;
}

interface ComplementCluster {
  id: number;
  action: string;
  members: Map<string, MemberData>;
  /** Target refcount over the union of member target instances. */
  refcount: Map<string, number>;
  totalInstances: number;
  flagged: boolean;
  announced: Map<string, AnnouncedState>;
  lastFlagAt: number;
}

interface SharedTargetGroup {
  id: number;
  action: string;
  targetKey: string;
  members: Map<string, MemberData>;
  flagged: boolean;
  announced: Map<string, AnnouncedState>;
  lastFlagAt: number;
}

interface SubjectState {
  subject: string;
  events: { action: string; targetKey?: string; cost: number; ts: number }[];
  lastActive: number;
}

export function createActionCohortTracker(
  options: ActionCohortTrackerOptions = {},
): ActionCohortTracker {
  const clock = options.now ?? (() => Date.now());
  const windowMs = Math.max(1, options.windowMs ?? 900_000);
  const linkOverlapCeiling = options.linkOverlapCeiling ?? 0.1;
  const flagMinMembers = Math.max(1, Math.floor(options.flagMinMembers ?? 8) || 8);
  const flagAggregateCost = Math.max(0, options.flagAggregateCost ?? 100);
  const flagTargetCoverage = Math.max(0, Math.floor(options.flagTargetCoverage ?? 10) || 0);
  const sharedMinSubjects = Math.max(1, Math.floor(options.sharedTargetMinSubjects ?? 6) || 6);
  const sharedAggregateCost = Math.max(0, options.sharedTargetAggregateCost ?? flagAggregateCost);
  const defaultAllowance = options.subjectAllowance ?? 100;
  const supplementaryCooldownMs = Math.max(0, options.supplementaryCooldownMs ?? 5_000);
  /** Materiality floors: 1/12 of each flag floor, rounded up, minimum 1 (herd derivation). */
  const materialCostFloor = Math.max(1, Math.ceil(Math.max(1, flagAggregateCost) / 12));
  const materialUniqueFloor = Math.max(1, Math.ceil(Math.max(1, flagTargetCoverage) / 12));

  const subjects = new Map<string, SubjectState>();
  const clustersByAction = new Map<string, ComplementCluster[]>();
  const sharedGroups = new Map<string, SharedTargetGroup>();
  const taintList: ActionTaint[] = [];
  let groupSeq = 0;

  const isProtected = (subject: string): boolean => {
    try {
      return options.isProtected?.(subject) === true;
    } catch {
      return false;
    }
  };

  const allowanceOf = (subject: string): number => {
    const fromHost = options.getAllowance?.(subject);
    return fromHost !== undefined && fromHost > 0 ? fromHost : defaultAllowance;
  };

  const isCanary = (action: string, targetKey: string): boolean => {
    if (options.canaryRegistry?.isCanaryTarget(action, targetKey)) return true;
    try {
      return options.isCanaryTarget?.(action, targetKey) === true;
    } catch {
      return false;
    }
  };

  /* ------------------------- derived member data ------------------------- */

  const rebuildMember = (member: MemberData): void => {
    member.targets.clear();
    member.cost = 0;
    for (const event of member.events) {
      member.cost += event.cost;
      member.targets.set(event.targetKey, (member.targets.get(event.targetKey) ?? 0) + 1);
    }
  };

  const rebuildCluster = (cluster: ComplementCluster): void => {
    cluster.refcount.clear();
    cluster.totalInstances = 0;
    for (const member of cluster.members.values()) {
      rebuildMember(member);
      for (const [target, count] of member.targets) {
        cluster.refcount.set(target, (cluster.refcount.get(target) ?? 0) + count);
        cluster.totalInstances += count;
      }
    }
  };

  const clusterAggregate = (cluster: ComplementCluster): number => {
    let sum = 0;
    for (const member of cluster.members.values()) sum += member.cost;
    return sum;
  };

  const groupAggregate = (group: SharedTargetGroup): number => {
    let sum = 0;
    for (const member of group.members.values()) sum += member.cost;
    return sum;
  };

  const uniqueOfCluster = (cluster: ComplementCluster, member: MemberData): number => {
    let unique = 0;
    for (const target of member.targets.keys()) if (cluster.refcount.get(target) === 1) unique++;
    return unique;
  };

  const uniqueOfShared = (group: SharedTargetGroup, member: MemberData): number => {
    // A shared group holds exactly one target; it is unique to a
    // member only while that member is its sole holder.
    return group.members.size === 1 && member.targets.has(group.targetKey) ? 1 : 0;
  };

  /* ------------------------------ pruning -------------------------------- */

  const pruneSubject = (state: SubjectState, atMs: number): void => {
    const cutoff = atMs - windowMs;
    state.events = state.events.filter(event => event.ts > cutoff);
  };

  const subjectWindowCost = (subject: string, atMs: number): number => {
    const state = subjects.get(subject);
    if (!state) return 0;
    pruneSubject(state, atMs);
    let sum = 0;
    for (const event of state.events) sum += event.cost;
    return sum;
  };

  const pruneCluster = (cluster: ComplementCluster, atMs: number): void => {
    const cutoff = atMs - windowMs;
    for (const [subject, member] of [...cluster.members]) {
      member.events = member.events.filter(event => event.ts > cutoff);
      if (member.events.length === 0) {
        cluster.members.delete(subject);
        cluster.announced.delete(subject);
      }
    }
    rebuildCluster(cluster);
    if (cluster.members.size === 0) {
      cluster.flagged = false;
      cluster.announced.clear();
      cluster.lastFlagAt = 0;
    }
  };

  const pruneShared = (group: SharedTargetGroup, atMs: number): void => {
    const cutoff = atMs - windowMs;
    for (const [subject, member] of [...group.members]) {
      member.events = member.events.filter(event => event.ts > cutoff);
      if (member.events.length === 0) {
        group.members.delete(subject);
        group.announced.delete(subject);
      } else {
        rebuildMember(member);
      }
    }
    if (group.members.size === 0) {
      group.flagged = false;
      group.announced.clear();
      group.lastFlagAt = 0;
    }
  };

  const pruneTaints = (atMs: number): void => {
    const cutoff = atMs - windowMs;
    for (let i = taintList.length - 1; i >= 0; i--) {
      if ((taintList[i] as ActionTaint).ts <= cutoff) taintList.splice(i, 1);
    }
  };

  /* --------------------------- snapshot / flags --------------------------- */

  const isMaterial = (cost: number, unique: number): boolean =>
    cost >= materialCostFloor || unique >= materialUniqueFloor;

  /** Settled = announced AND (material at announcement, or announced at exactly zero contribution). */
  const announcementSettled = (announced: AnnouncedState | undefined): boolean =>
    announced !== undefined &&
    ((announced.cost === 0 && announced.unique === 0) || isMaterial(announced.cost, announced.unique));

  const taintedFor = (
    action: string,
    memberSet: Set<string>,
    groupTargets: Set<string>,
    atMs: number,
  ): string[] => {
    pruneTaints(atMs);
    const out = new Set<string>();
    for (const taint of taintList) {
      if (taint.action !== action) continue;
      if (memberSet.has(taint.subject)) {
        out.add(taint.subject);
        continue;
      }
      const state = subjects.get(taint.subject);
      if (!state) continue;
      pruneSubject(state, atMs);
      const intersects = state.events.some(
        event => event.action === action && event.targetKey !== undefined && groupTargets.has(event.targetKey),
      );
      if (intersects) out.add(taint.subject);
    }
    return [...out];
  };

  const buildSnapshot = (
    groupId: number,
    mechanism: ActionCohortMechanism,
    members: MemberData[],
    aggregateCost: number,
    targetCoverage: number,
    uniqueOf: (member: MemberData) => number,
    action: string,
    groupTargets: Set<string>,
    atMs: number,
    supplementary: boolean,
  ): ActionCohortFlagSnapshot => {
    const memberCost: Record<string, number> = {};
    const memberTargetCounts: Record<string, number> = {};
    const memberUniqueTargetCounts: Record<string, number> = {};
    const memberNames: string[] = [];
    for (const member of members) {
      memberNames.push(member.subject);
      memberCost[member.subject] = member.cost;
      memberTargetCounts[member.subject] = member.targets.size;
      memberUniqueTargetCounts[member.subject] = uniqueOf(member);
    }
    const snapshot: ActionCohortFlagSnapshot = {
      groupId,
      mechanism,
      members: memberNames,
      memberCost,
      memberTargetCounts,
      memberUniqueTargetCounts,
      aggregateCost,
      targetCoverage,
      taintedMembers: taintedFor(action, new Set(memberNames), groupTargets, atMs),
      protectedMembers: memberNames.filter(isProtected),
      ...(supplementary ? { supplementary: true } : {}),
      timestamp: new Date(atMs).toISOString(),
    };
    if (options.onFlag) {
      try {
        const result = options.onFlag(snapshot);
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        /* Operator wiring must never break request handling. */
      }
    }
    return snapshot;
  };

  const markAnnounced = (
    announced: Map<string, AnnouncedState>,
    snapshot: ActionCohortFlagSnapshot,
  ): void => {
    for (const member of snapshot.members) {
      if (announcementSettled(announced.get(member))) continue;
      announced.set(member, {
        cost: snapshot.memberCost[member] ?? 0,
        unique: snapshot.memberUniqueTargetCounts[member] ?? 0,
      });
    }
  };

  /** Dilution gate: at least 60% of members individually at/below their allowance (integer arithmetic: count*5 >= members*3). */
  const dilutionPasses = (cluster: ComplementCluster, atMs: number): boolean => {
    const members = [...cluster.members.keys()];
    if (members.length === 0) return false;
    let atOrBelow = 0;
    for (const member of members) {
      if (subjectWindowCost(member, atMs) <= allowanceOf(member)) atOrBelow++;
    }
    return atOrBelow * 5 >= members.length * 3;
  };

  const evaluateComplement = (
    cluster: ComplementCluster,
    atMs: number,
  ): ActionCohortFlagSnapshot | undefined => {
    if (cluster.members.size === 0) return undefined;
    const aggregate = clusterAggregate(cluster);
    const coverage = cluster.refcount.size;
    const gatesPass =
      cluster.members.size >= flagMinMembers &&
      aggregate >= flagAggregateCost &&
      coverage >= flagTargetCoverage &&
      dilutionPasses(cluster, atMs);
    if (!cluster.flagged) {
      if (!gatesPass) return undefined;
      cluster.flagged = true;
      cluster.lastFlagAt = atMs;
      const snapshot = buildSnapshot(
        cluster.id,
        "complement",
        [...cluster.members.values()],
        aggregate,
        coverage,
        member => uniqueOfCluster(cluster, member),
        cluster.action,
        new Set(cluster.refcount.keys()),
        atMs,
        false,
      );
      markAnnounced(cluster.announced, snapshot);
      return snapshot;
    }
    // Supplementary re-announcement (herd discipline).
    if (atMs - cluster.lastFlagAt < supplementaryCooldownMs) return undefined;
    if (!gatesPass) return undefined;
    let hasNewMaterial = false;
    for (const member of cluster.members.values()) {
      if (announcementSettled(cluster.announced.get(member.subject))) continue;
      if (isMaterial(member.cost, uniqueOfCluster(cluster, member))) {
        hasNewMaterial = true;
        break;
      }
    }
    if (!hasNewMaterial) return undefined;
    cluster.lastFlagAt = atMs;
    const snapshot = buildSnapshot(
      cluster.id,
      "complement",
      [...cluster.members.values()],
      aggregate,
      coverage,
      member => uniqueOfCluster(cluster, member),
      cluster.action,
      new Set(cluster.refcount.keys()),
      atMs,
      true,
    );
    markAnnounced(cluster.announced, snapshot);
    return snapshot;
  };

  const evaluateShared = (
    group: SharedTargetGroup,
    atMs: number,
  ): ActionCohortFlagSnapshot | undefined => {
    if (group.members.size === 0) return undefined;
    const aggregate = groupAggregate(group);
    const gatesPass = group.members.size >= sharedMinSubjects && aggregate >= sharedAggregateCost;
    const targets = new Set<string>([group.targetKey]);
    if (!group.flagged) {
      if (!gatesPass) return undefined;
      group.flagged = true;
      group.lastFlagAt = atMs;
      const snapshot = buildSnapshot(
        group.id,
        "shared-target",
        [...group.members.values()],
        aggregate,
        1,
        member => uniqueOfShared(group, member),
        group.action,
        targets,
        atMs,
        false,
      );
      markAnnounced(group.announced, snapshot);
      return snapshot;
    }
    if (atMs - group.lastFlagAt < supplementaryCooldownMs) return undefined;
    if (!gatesPass) return undefined;
    let hasNewMaterial = false;
    for (const member of group.members.values()) {
      if (announcementSettled(group.announced.get(member.subject))) continue;
      if (isMaterial(member.cost, uniqueOfShared(group, member))) {
        hasNewMaterial = true;
        break;
      }
    }
    if (!hasNewMaterial) return undefined;
    group.lastFlagAt = atMs;
    const snapshot = buildSnapshot(
      group.id,
      "shared-target",
      [...group.members.values()],
      aggregate,
      1,
      member => uniqueOfShared(group, member),
      group.action,
      targets,
      atMs,
      true,
    );
    markAnnounced(group.announced, snapshot);
    return snapshot;
  };

  /* --------------------------- grouping: merges --------------------------- */

  const overlapRatioAfterMerge = (a: ComplementCluster, b: ComplementCluster): number => {
    const distinct = new Set<string>([...a.refcount.keys(), ...b.refcount.keys()]).size;
    const total = a.totalInstances + b.totalInstances;
    if (total === 0) return 0;
    return 1 - distinct / total;
  };

  const mergeInto = (dst: ComplementCluster, src: ComplementCluster): void => {
    for (const [subject, member] of src.members) dst.members.set(subject, member);
    for (const [subject, announced] of src.announced) {
      if (!dst.announced.has(subject)) dst.announced.set(subject, announced);
    }
    if (src.flagged && !dst.flagged) dst.flagged = true;
    if (src.lastFlagAt > dst.lastFlagAt) dst.lastFlagAt = src.lastFlagAt;
    src.members.clear();
    src.announced.clear();
    rebuildCluster(src);
    rebuildCluster(dst);
  };

  /**
   * Repeatedly merge `cluster` with any cluster (same action) whose
   * aggregate accepts it. The OLDER cluster survives as the merge
   * target, so group ids and member order stay chronological as a
   * group absorbs later identities. Returns the surviving cluster.
   * Each pass re-reads the LIVE cluster list: merging into a stale
   * snapshot entry (and splicing at index -1) would silently drop an
   * unrelated live cluster.
   */
  const attemptMerges = (clusters: ComplementCluster[], cluster: ComplementCluster): ComplementCluster => {
    let current = cluster;
    for (;;) {
      const other = clusters.find(
        candidate =>
          candidate !== current &&
          overlapRatioAfterMerge(current, candidate) <= linkOverlapCeiling + 1e-12,
      );
      if (!other) return current;
      if (other.id < current.id) {
        mergeInto(other, current);
        const idx = clusters.indexOf(current);
        if (idx >= 0) clusters.splice(idx, 1);
        current = other;
      } else {
        mergeInto(current, other);
        const idx = clusters.indexOf(other);
        if (idx >= 0) clusters.splice(idx, 1);
      }
    }
  };

  const findClusterOf = (clusters: ComplementCluster[], subject: string): ComplementCluster | undefined =>
    clusters.find(cluster => cluster.members.has(subject));

  const newMember = (subject: string): MemberData => ({
    subject,
    events: [],
    targets: new Map<string, number>(),
    cost: 0,
  });

  /* ------------------------------- observe -------------------------------- */

  const observe = (event: ActionEvent): ActionCohortObservation => {
    if (
      !event ||
      typeof event.subject !== "string" ||
      event.subject.length === 0 ||
      typeof event.action !== "string" ||
      event.action.length === 0
    ) {
      return { recorded: false };
    }
    const atMs = typeof event.ts === "number" && Number.isFinite(event.ts) ? event.ts : clock();
    const cost = typeof event.cost === "number" && Number.isFinite(event.cost) ? Math.max(0, event.cost) : 0;

    let subjectState = subjects.get(event.subject);
    if (!subjectState) {
      subjectState = { subject: event.subject, events: [], lastActive: atMs };
      subjects.set(event.subject, subjectState);
    }
    pruneSubject(subjectState, atMs);
    subjectState.events.push({
      action: event.action,
      ...(event.targetKey !== undefined ? { targetKey: event.targetKey } : {}),
      cost,
      ts: atMs,
    });
    subjectState.lastActive = atMs;

    // Canary contact: direct per-subject evidence. Recorded against
    // the toucher only - never splashed onto anyone else, and a
    // protected subject's own hit taints that subject alone.
    if (event.targetKey !== undefined && isCanary(event.action, event.targetKey)) {
      pruneTaints(atMs);
      const existing = taintList.findIndex(
        taint => taint.subject === event.subject && taint.action === event.action && taint.targetKey === event.targetKey,
      );
      const taint: ActionTaint = {
        subject: event.subject,
        action: event.action,
        targetKey: event.targetKey,
        ts: atMs,
      };
      if (existing >= 0) taintList[existing] = taint;
      else taintList.push(taint);
    }

    if (event.targetKey === undefined) return { recorded: true };
    const targetKey = event.targetKey;
    let flag: ActionCohortFlagSnapshot | undefined;

    /* Complement grouping (leader-based, against cluster aggregates). */
    let clusters = clustersByAction.get(event.action);
    if (!clusters) {
      clusters = [];
      clustersByAction.set(event.action, clusters);
    }
    for (const cluster of [...clusters]) pruneCluster(cluster, atMs);
    for (let i = clusters.length - 1; i >= 0; i--) {
      if ((clusters[i] as ComplementCluster).members.size === 0) clusters.splice(i, 1);
    }
    let own = findClusterOf(clusters, event.subject);
    if (!own) {
      own = {
        id: ++groupSeq,
        action: event.action,
        members: new Map<string, MemberData>(),
        refcount: new Map<string, number>(),
        totalInstances: 0,
        flagged: false,
        announced: new Map<string, AnnouncedState>(),
        lastFlagAt: 0,
      };
      own.members.set(event.subject, newMember(event.subject));
      clusters.push(own);
    }
    const ownMember = own.members.get(event.subject) as MemberData;
    ownMember.events.push({ targetKey, cost, ts: atMs });
    rebuildMember(ownMember);
    rebuildCluster(own);
    own = attemptMerges(clusters, own);
    const complementFlag = evaluateComplement(own, atMs);
    if (complementFlag) flag = complementFlag;

    /* Shared-target grouping (same targetKey, any number of subjects). */
    const sharedKey = `${event.action}\0${targetKey}`;
    let shared = sharedGroups.get(sharedKey);
    if (shared) pruneShared(shared, atMs);
    if (shared && shared.members.size === 0) {
      sharedGroups.delete(sharedKey);
      shared = undefined;
    }
    if (!shared) {
      shared = {
        id: ++groupSeq,
        action: event.action,
        targetKey,
        members: new Map<string, MemberData>(),
        flagged: false,
        announced: new Map<string, AnnouncedState>(),
        lastFlagAt: 0,
      };
      sharedGroups.set(sharedKey, shared);
    }
    let sharedMember = shared.members.get(event.subject);
    if (!sharedMember) {
      sharedMember = newMember(event.subject);
      shared.members.set(event.subject, sharedMember);
    }
    sharedMember.events.push({ targetKey, cost, ts: atMs });
    rebuildMember(sharedMember);
    const sharedFlag = evaluateShared(shared, atMs);
    if (sharedFlag && !flag) flag = sharedFlag;

    return flag ? { recorded: true, flag } : { recorded: true };
  };

  /* --------------------- attempt-time evaluation -------------------------- */

  /**
   * Pure join evaluation (Fix A). Reads live grouping state only:
   * no pruning, no rebuilds, no snapshot, no `onFlag`, no taint -
   * calling it any number of times leaves the tracker byte-identical.
   *
   * wouldJoin replays the exact observe-time link logic for a
   * one-target observation of the subject against each complement
   * cluster of the event's action: a subject already in a cluster
   * would (re)join its own cluster unconditionally (observe adds to
   * the member's own cluster without a ceiling check); any other
   * subject joins when the merged overlap ratio - the cluster's
   * aggregate refcount plus the event's single target instance -
   * stays at or below `linkOverlapCeiling`, the same comparison
   * (including tolerance) `attemptMerges` makes. An event with no
   * targetKey never joins (observe returns before grouping).
   */
  const evaluateAction = (event: ActionEvaluationEvent): ActionCohortEvaluation => {
    if (!event || typeof event.action !== "string" || event.action.length === 0) {
      return { clusters: [], sharedTargets: [] };
    }
    const subject =
      typeof event.subject === "string" && event.subject.length > 0
        ? event.subject
        : typeof event.subjectKey === "string" && event.subjectKey.length > 0
          ? event.subjectKey
          : undefined;
    if (subject === undefined) return { clusters: [], sharedTargets: [] };

    const clusters: ActionCohortEvaluationCluster[] = [];
    for (const cluster of clustersByAction.get(event.action) ?? []) {
      if (cluster.members.size === 0) continue;
      let wouldJoin = false;
      if (cluster.members.has(subject)) {
        wouldJoin = true;
      } else if (event.targetKey !== undefined) {
        const distinct =
          cluster.refcount.size + (cluster.refcount.has(event.targetKey) ? 0 : 1);
        const total = cluster.totalInstances + 1;
        const ratio = total === 0 ? 0 : 1 - distinct / total;
        wouldJoin = ratio <= linkOverlapCeiling + 1e-12;
      }
      clusters.push({
        groupId: cluster.id,
        mechanism: "complement",
        flagged: cluster.flagged,
        wouldJoin,
        targetKnown: event.targetKey !== undefined && cluster.refcount.has(event.targetKey),
      });
    }

    const sharedTargets: ActionCohortEvaluationSharedTarget[] = [];
    if (event.targetKey !== undefined) {
      const group = sharedGroups.get(`${event.action}\0${event.targetKey}`);
      if (group && group.members.size > 0) {
        sharedTargets.push({
          action: group.action,
          targetKey: group.targetKey,
          flagged: group.flagged,
          subjectCount: group.members.size,
        });
      }
    }
    return { clusters, sharedTargets };
  };

  /* --------------------------- diagnostics -------------------------------- */

  const groups = (): ActionGroupInfo[] => {
    const out: ActionGroupInfo[] = [];
    for (const clusters of clustersByAction.values()) {
      for (const cluster of clusters) {
        out.push({
          groupId: cluster.id,
          mechanism: "complement",
          action: cluster.action,
          members: [...cluster.members.keys()],
          aggregateCost: clusterAggregate(cluster),
          targetCoverage: cluster.refcount.size,
          flagged: cluster.flagged,
        });
      }
    }
    for (const group of sharedGroups.values()) {
      out.push({
        groupId: group.id,
        mechanism: "shared-target",
        action: group.action,
        targetKey: group.targetKey,
        members: [...group.members.keys()],
        aggregateCost: groupAggregate(group),
        targetCoverage: group.members.size > 0 ? 1 : 0,
        flagged: group.flagged,
      });
    }
    return out;
  };

  const removeSubject = (subject: string): void => {
    subjects.delete(subject);
    for (let i = taintList.length - 1; i >= 0; i--) {
      if ((taintList[i] as ActionTaint).subject === subject) taintList.splice(i, 1);
    }
    for (const clusters of clustersByAction.values()) {
      for (const cluster of [...clusters]) {
        if (cluster.members.delete(subject)) {
          cluster.announced.delete(subject);
          rebuildCluster(cluster);
        }
        if (cluster.members.size === 0) clusters.splice(clusters.indexOf(cluster), 1);
      }
    }
    for (const [key, group] of [...sharedGroups]) {
      if (group.members.delete(subject)) {
        group.announced.delete(subject);
        if (group.members.size === 0) sharedGroups.delete(key);
      }
    }
  };

  const reset = (subject?: string): void => {
    if (subject === undefined) {
      subjects.clear();
      clustersByAction.clear();
      sharedGroups.clear();
      taintList.length = 0;
      return;
    }
    removeSubject(subject);
  };

  return {
    observe,
    evaluateAction,
    groups,
    reset,
    taints() {
      pruneTaints(clock());
      return taintList.map(taint => ({ ...taint }));
    },
    actionFrictionTargets(snapshot, opts = {}) {
      return actionFrictionTargets(snapshot, {
        flagAggregateCost: opts.flagAggregateCost ?? flagAggregateCost,
        flagTargetCoverage: opts.flagTargetCoverage ?? flagTargetCoverage,
        ...(opts.minCost !== undefined ? { minCost: opts.minCost } : {}),
        ...(opts.minUniqueTargets !== undefined ? { minUniqueTargets: opts.minUniqueTargets } : {}),
      });
    },
  };
}
