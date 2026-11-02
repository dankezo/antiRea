/**
 * Host-declared protected cohorts (compliance / audit / support /
 * agreed pentest).
 *
 * Why this exists (Danny's ruling, 09:44 02/11/2026): the one
 * measured false-positive shape for herd/CUSUM inference - a small
 * team systematically reviewing a full segment from shared
 * infrastructure - is rare in practice, and in real organizations it
 * is a DECLARED activity: audits are scheduled with named accounts,
 * support teams are known, penetration tests run under written rules
 * of engagement. So instead of weakening detection for everyone, the
 * SDK flips the default (inferred cohorts now receive friction by
 * default, see `enforcement-tiering.ts`) and gives the host a clean,
 * auditable way to declare the subjects that inference must never
 * consequence: the compliance team's accounts before their quarterly
 * review, the support floor's service accounts, the pentest window's
 * tester accounts.
 *
 * Semantics, kept deliberately narrow:
 *
 * - Protection covers consequences derived from INFERRED evidence
 *   only (a herd flag, a CUSUM cohort crossing). Telemetry is
 *   untouched: a protected subject's events still accrue, cohorts
 *   still form and flag, snapshots still list the subject - the
 *   declaration suppresses consequences, not observation.
 * - Protection does NOT cover consequences the host itself
 *   authorized (a host-declared cohort's ceiling is the host's own
 *   decision), nor direct per-subject evidence about the subject's
 *   own actions (e.g. a flow-scorer taint from the subject's own
 *   programmatic decoy hit): those are not inference about a group,
 *   and a declaration must not become a laundering lane for them.
 * - A declaration is an auditable artifact: it records who was
 *   declared, an optional reason, when, and an optional expiry after
 *   which protection lapses on its own (a pentest window should not
 *   protect anyone forever). Removing protection is equally
 *   deliberate: it takes a new decision by the host, not a detector
 *   event.
 *
 * Hosts wire it in two places: engines that take an `isProtected`
 * predicate (the CUSUM tripwire does) get `registry.isProtected`
 * directly; host-side consequence code (herd flag handlers, step-up
 * enrollment) partitions its target list through
 * `partitionConsequenceTargets` or gates single subjects through
 * `guardInferredConsequence`.
 */

import type { EnforcementAction } from "./enforcement-tiering";

export interface ProtectedDeclarationInput {
  /**
   * Why these subjects are protected, in the host's words (e.g.
   * "Q3 compliance review, ticket SEC-2211"). Recorded verbatim on
   * the declaration; never interpreted by the SDK.
   */
  reason?: string;
  /**
   * Optional expiry (ms epoch). Protection lapses after this
   * instant; a declaration without one protects until the process
   * ends or the registry is discarded.
   */
  expiresAtMs?: number;
}

export interface ProtectedDeclaration extends ProtectedDeclarationInput {
  /** Subjects covered by this declaration (identity keys, e.g. `account:<id>`). */
  subjects: string[];
  declaredAtMs: number;
}

export interface ProtectedConsequenceVerdict {
  subject: string;
  protectedSubject: boolean;
  /** The action that may be applied for inferred-evidence reasons. */
  action: EnforcementAction;
  clamped: boolean;
  reason: string;
}

export interface ProtectedCohortRegistry {
  /**
   * Declare one subject, a list of subjects, or a whole cohort
   * protected. Repeated declarations accumulate; re-declaring a
   * subject adds another declaration rather than replacing the old
   * one (the audit trail keeps both).
   */
  declareProtected(
    subjects: string | readonly string[],
    declaration?: ProtectedDeclarationInput,
  ): ProtectedDeclaration;
  /** True while any unexpired declaration covers the subject. */
  isProtected(subject: string): boolean;
  /** All currently protected subjects, sorted. */
  protectedSubjects(): string[];
  /** Every declaration ever made on this registry, in order. */
  declarations(): ProtectedDeclaration[];
  /**
   * Gate one inferred-evidence consequence for one subject: a
   * protected subject's consequence collapses to `observe` (the
   * evidence is still recorded by the caller's engine); anyone else
   * passes through unchanged - the tiering clamp in
   * `enforcement-tiering.ts` remains responsible for how heavy an
   * unprotected subject's consequence may be.
   */
  guardInferredConsequence(subject: string, requested: EnforcementAction): ProtectedConsequenceVerdict;
  /**
   * Partition a consequence target list (e.g. a flagged cohort's
   * members) into the subjects the consequence may be applied to
   * and the protected subjects it must skip.
   */
  partitionConsequenceTargets(subjects: readonly string[]): {
    applicable: string[];
    protectedSubjects: string[];
  };
}

export interface ProtectedCohortRegistryOptions {
  now?: () => number;
}

export function createProtectedCohortRegistry(
  options: ProtectedCohortRegistryOptions = {},
): ProtectedCohortRegistry {
  const now = options.now ?? Date.now;
  const declarations: ProtectedDeclaration[] = [];

  const active = (declaration: ProtectedDeclaration, atMs: number): boolean =>
    declaration.expiresAtMs === undefined || atMs < declaration.expiresAtMs;

  const isProtected = (subject: string): boolean => {
    const atMs = now();
    return declarations.some(d => active(d, atMs) && d.subjects.includes(subject));
  };

  return {
    declareProtected(subjects, declaration = {}) {
      const list = [...new Set(typeof subjects === "string" ? [subjects] : [...subjects])];
      const record: ProtectedDeclaration = {
        subjects: list,
        ...(declaration.reason !== undefined ? { reason: declaration.reason } : {}),
        ...(declaration.expiresAtMs !== undefined ? { expiresAtMs: declaration.expiresAtMs } : {}),
        declaredAtMs: now(),
      };
      declarations.push(record);
      return record;
    },

    isProtected,

    protectedSubjects() {
      const atMs = now();
      const out = new Set<string>();
      for (const d of declarations) {
        if (!active(d, atMs)) continue;
        for (const subject of d.subjects) out.add(subject);
      }
      return [...out].sort();
    },

    declarations() {
      return declarations.map(d => ({ ...d, subjects: [...d.subjects] }));
    },

    guardInferredConsequence(subject, requested) {
      if (isProtected(subject)) {
        return {
          subject,
          protectedSubject: true,
          action: "observe",
          clamped: requested !== "observe",
          reason:
            "protected subject (host-declared): inferred-evidence consequences are suppressed; telemetry is unaffected",
        };
      }
      return {
        subject,
        protectedSubject: false,
        action: requested,
        clamped: false,
        reason: "subject is not covered by a protected declaration",
      };
    },

    partitionConsequenceTargets(subjects) {
      const applicable: string[] = [];
      const protectedList: string[] = [];
      for (const subject of new Set(subjects)) {
        (isProtected(subject) ? protectedList : applicable).push(subject);
      }
      return { applicable, protectedSubjects: protectedList };
    },
  };
}
