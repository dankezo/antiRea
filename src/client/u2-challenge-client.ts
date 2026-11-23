/**
 * U2 client component (DEC-1, antiRea 3.3.2) - the ONE place the
 * server-only law is broken, scoped to U2 alone. Nothing else in
 * the SDK ships client code, and this component does nothing else.
 *
 * FROZEN HONEST FRAMING - never exceed this anywhere: U2 is an
 * EXECUTION TAX, not a wall. A real agent that executes JavaScript
 * still passes - this component is exactly that execution, packaged
 * for the host's own legitimate page. It exists so a real browser
 * session can answer the per-session polymorphic challenge the
 * server issued (src/tier2-active/polymorphic-challenge.ts) and
 * unlock the host's next step (step-up).
 *
 * EXECUTION BOUNDARY (read before wiring this up). This component
 * executes JavaScript source it did not write - that is the whole
 * contract of U2, and it is bounded as follows:
 *   - It executes ONLY an issuance object in the exact shape the
 *     host's own server produced: { challengeId, payload,
 *     entryName, expiresAt }. It fetches no code, loads no script
 *     URLs, and accepts no other source string from anywhere.
 *   - `entryName` is validated as a plain identifier before it is
 *     used to look the entry function up; the payload runs inside
 *     a fresh function scope (`new Function`), never in the page's
 *     global scope, and nothing the payload defines leaks out
 *     except the single entry function's return value.
 *   - The host must feed it issuances only from its own server
 *     over its normal trusted (HTTPS) channel. Feeding it payloads
 *     from any other origin turns it into an eval of foreign code;
 *     that is outside this contract and on the host.
 *   - The answer is not a credential and proves nothing beyond
 *     "this session executed this challenge": the server verifies
 *     it as single-use and expiring (see the server module).
 *
 * SHAPE. Framework-free, no DOM assumptions: the component never
 * touches `document`/`window`. Submission goes through an
 * injectable transport callback the host supplies - a callback
 * that POSTs the request to the host's own verify endpoint - so
 * the host keeps full control of its own endpoints and headers.
 * This component itself performs no network call of any kind:
 * without a host transport it can solve but never submit.
 */

export interface U2ChallengeIssue {
  challengeId: string;
  /** JavaScript source issued by the host's server for this session. */
  payload: string;
  /** Name of the payload's entry function (rotated per challenge). */
  entryName: string;
  /** Expiry, ms since epoch, on the server's clock. */
  expiresAt: number;
}

export interface U2SubmitRequest {
  challengeId: string;
  answer: string;
}

/** Host-supplied submission channel; returns the server's verdict verbatim. */
export type U2Transport = (request: U2SubmitRequest) => Promise<unknown>;

export interface U2ChallengeClientOptions {
  transport?: U2Transport;
}

const ENTRY_NAME = /^_[A-Za-z][A-Za-z0-9]*$/;

function assertIssue(issue: U2ChallengeIssue): void {
  if (typeof issue !== "object" || issue === null) {
    throw new TypeError("u2 client: issue must be an object");
  }
  if (typeof issue.challengeId !== "string" || issue.challengeId.length === 0) {
    throw new TypeError("u2 client: issue.challengeId must be a non-empty string");
  }
  if (typeof issue.payload !== "string" || issue.payload.length === 0) {
    throw new TypeError("u2 client: issue.payload must be a non-empty string");
  }
  if (typeof issue.entryName !== "string" || !ENTRY_NAME.test(issue.entryName)) {
    throw new TypeError("u2 client: issue.entryName must be a rotated identifier");
  }
}

/**
 * Execute one issued U2 payload in a fresh function scope and
 * return its answer string. Executes only the issuance contract
 * described in the header - no other source is ever run.
 */
export function solveU2Challenge(issue: U2ChallengeIssue): string {
  assertIssue(issue);
  const factory = new Function(`${issue.payload}\nreturn ${issue.entryName};`);
  const entry: unknown = factory();
  if (typeof entry !== "function") {
    throw new TypeError("u2 client: payload did not define its entry function");
  }
  const answer: unknown = (entry as () => unknown)();
  if (typeof answer !== "string" && typeof answer !== "number") {
    throw new TypeError("u2 client: entry function must return a string or number answer");
  }
  return String(answer);
}

export interface U2ChallengeClient {
  /** Solve an issuance locally; does not submit anything. */
  solve(issue: U2ChallengeIssue): string;
  /** Solve an issuance and submit { challengeId, answer } via the transport. */
  submit(issue: U2ChallengeIssue): Promise<unknown>;
}

/** Create the minimal DEC-1 client for U2 challenges. */
export function createU2ChallengeClient(options: U2ChallengeClientOptions = {}): U2ChallengeClient {
  const transport = options.transport;
  return {
    solve(issue: U2ChallengeIssue): string {
      return solveU2Challenge(issue);
    },
    async submit(issue: U2ChallengeIssue): Promise<unknown> {
      if (typeof transport !== "function") {
        throw new TypeError("u2 client: a transport callback is required to submit");
      }
      const answer = solveU2Challenge(issue);
      return transport({ challengeId: issue.challengeId, answer });
    },
  };
}
