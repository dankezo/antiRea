/**
 * Semantic invariant trap (antiRea 3.3.3, X33-11) - OPT-IN,
 * default OFF.
 *
 * WHAT IT DOES. Some of what an extractor carries away is not
 * data but a RULE it inferred: a pricing policy, a shipping
 * policy, a discount formula. This module serves a flagged
 * identity a decoy rule that AGREES with the real rule on every
 * example the surface shows, and diverges only at inputs the
 * surface never shows. The consumer verifies the rule against
 * all visible examples, finds it confirmed everywhere, and
 * adopts it - and the rule is wrong exactly where it was never
 * checked. Ported from the headline twin
 * (twin-server-x33-headline.cjs: real rule h_r "free shipping
 * iff order total >= 100", decoy rule h_d "free shipping iff
 * item count >= 5", flat fee 6.00, and the 8 SHIP_EXAMPLES, all
 * inside the agreement set of the two rules).
 *
 * THE IDENTIFIABILITY PRECONDITION IS THE MECHANISM. If any
 * shown example separated the two rules, a checking consumer
 * could tell them apart and the decoy would be worthless.
 * Construction therefore VALIDATES the precondition: for every
 * agreement example, the decoy rule's output must deep-equal
 * the real rule's output, and construction throws - naming the
 * failing example index - when one does not. A host cannot
 * accidentally ship a separable trap.
 *
 * MEASURED BASIS. X33-11 passed Wave 2; in the headline trial
 * and in the HV-00a real-configuration arm (REA x OpenCode x
 * DeepSeek V4.1 Flash free), runs on the FULL surface adopted
 * the decoy rule verbatim in their final answers and declared
 * it verified. All agent numbers in this program are lab
 * numbers on free models.
 *
 * CLAIM DISCIPLINE (freeze section 2.2). This module poisons a
 * rule a flagged consumer infers. It prevents no record from
 * being read and makes no cost claim.
 *
 * CONTRACT.
 * - Disabled, or for a clean identity, every accessor resolves
 *   to the real rule: behavior byte-identical to 3.3.2.
 * - `examplesFor` computes each example's output under the
 *   identity's own rule; by the construction precondition the
 *   outputs are identical across identities - only the stated
 *   rule (and off-example behavior) differs.
 */

export interface InvariantRule<I, O> {
  id: string;
  statement: string;
  evaluate: (input: I) => O;
}

export interface InvariantAgreementExample<I> {
  input: I;
  note?: string;
}

export interface InvariantTrapOptions<I, O> {
  /** The module acts only when this is exactly `true`. Default false (OFF). */
  enabled?: boolean;
  /** Flagging seam: return true for identities that receive the decoy rule. Default: nobody is flagged. */
  isFlagged?: (identity: string) => boolean;
  /** The rule clean identities (and the OFF module) implement. */
  realRule: InvariantRule<I, O>;
  /** The rule flagged identities are taught. Must agree with `realRule` on every agreement example. */
  decoyRule: InvariantRule<I, O>;
  /** The shown examples; the identifiability precondition is validated over all of them at construction. */
  agreementExamples: Array<InvariantAgreementExample<I>>;
  /** Output equality for the precondition check. Default: JSON-based deep equal. */
  equals?: (a: O, b: O) => boolean;
}

export interface InvariantExampleView<I, O> {
  input: I;
  note?: string;
  output: O;
}

export interface InvariantTrap<I, O> {
  readonly enabled: boolean;
  /** The rule this identity's surface implements. */
  ruleFor: (identity: string) => InvariantRule<I, O>;
  /** The stated rule text for this identity. */
  statementFor: (identity: string) => string;
  /** Evaluate the identity's rule on an input. */
  evaluateFor: (identity: string, input: I) => O;
  /** The shown examples with outputs under the identity's rule (identical across identities by construction). */
  examplesFor: (identity: string) => Array<InvariantExampleView<I, O>>;
}

export class InvariantTrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvariantTrapError";
  }
}

const jsonDeepEqual = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Create the invariant trap. See the module header for the full contract. */
export function createInvariantTrap<I, O>(opts: InvariantTrapOptions<I, O>): InvariantTrap<I, O> {
  const enabled = opts.enabled === true;
  const isFlagged = opts.isFlagged ?? (() => false);
  const equals: (a: O, b: O) => boolean = opts.equals ?? jsonDeepEqual;

  // Identifiability precondition: the decoy rule must be
  // indistinguishable from the real rule on every shown example.
  for (let i = 0; i < opts.agreementExamples.length; i++) {
    const example = opts.agreementExamples[i] as InvariantAgreementExample<I>;
    const realOut = opts.realRule.evaluate(example.input);
    const decoyOut = opts.decoyRule.evaluate(example.input);
    if (!equals(realOut, decoyOut)) {
      throw new InvariantTrapError(
        `createInvariantTrap: agreement example ${i} separates the rules ` +
        `(real rule "${opts.realRule.id}" and decoy rule "${opts.decoyRule.id}" disagree on it); ` +
        "a shown example must never separate the decoy rule from the real rule",
      );
    }
  }

  const ruleFor = (identity: string): InvariantRule<I, O> =>
    enabled && isFlagged(identity) ? opts.decoyRule : opts.realRule;

  return {
    enabled,
    ruleFor,
    statementFor: (identity) => ruleFor(identity).statement,
    evaluateFor: (identity, input) => ruleFor(identity).evaluate(input),
    examplesFor: (identity) => {
      const rule = ruleFor(identity);
      return opts.agreementExamples.map((example) => {
        const view: InvariantExampleView<I, O> = { input: example.input, output: rule.evaluate(example.input) };
        if (example.note !== undefined) view.note = example.note;
        return view;
      });
    },
  };
}
