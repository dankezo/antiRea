/**
 * Policy signals: honest, machine-readable policy DECLARATIONS.
 *
 * This module generates the text and JSON a host publishes to state
 * how its content may be used after it is fetched. It produces four
 * artifacts from one set of host choices:
 *
 * - robots.txt lines carrying a Content-Signal directive
 *   (Cloudflare's Content Signals Policy, September 2025, released
 *   CC0; spec at contentsignals.org). Directives: `search`,
 *   `ai-input`, `ai-train`; values `yes` / `no`. A directive that is
 *   omitted expresses no preference - this generator always emits
 *   all three, because the host passes all three choices in.
 * - robots.txt lines carrying a `Content-Usage` directive from the
 *   IETF AI Preferences (aipref) working group: the vocabulary draft
 *   `draft-ietf-aipref-vocab` (categories `train-ai`, `ai-use`,
 *   `search`; values `y` / `n`) as attached by
 *   `draft-ietf-aipref-attach`. Mapping from the host's choices:
 *   `aiTrain` -> `train-ai`, `aiInput` -> `ai-use`,
 *   `search` -> `search`. THESE FORMATS ARE INTERNET-DRAFTS, NOT A
 *   FINISHED STANDARD: this module emits the CURRENT DRAFT
 *   vocabulary and the emitted lines will likely need to change when
 *   the drafts change.
 * - A TDMRep document for `/.well-known/tdmrep.json`, following the
 *   W3C Text and Data Mining Reservation Protocol Community Group
 *   Final Report (2024-05-10). Per that report the document is a
 *   JSON ARRAY of rule objects (the brackets are mandatory even for
 *   a single rule); each rule carries a `location`, a
 *   `tdm-reservation` of 1 (TDM rights reserved - the Article 4,
 *   Directive (EU) 2019/790 opt-out) or 0 (not reserved), and an
 *   optional `tdm-policy` URL pointing at the host's TDM policy.
 *   The same report's header form (`tdm-reservation` /
 *   `tdm-policy` response fields) is available via `headers()`.
 * - A well-known policy JSON of antiRea's OWN design
 *   (`/.well-known/antirea-policy.json` shape) tying the above
 *   together: contact, scope and the same signal summary. It is
 *   plainly an antiRea document - it is not a standard, and no field
 *   in it pretends to be one.
 *
 * CLAIM DISCIPLINE - read this before using the output. This module
 * GENERATES DECLARATIONS ONLY. It enforces nothing and blocks
 * nothing: no request is inspected, refused or slowed by anything
 * here. These signals bind only agents that choose to honor them.
 * As of this writing NO major crawler is known to consume
 * Content-Signal (Google has publicly stated none of its crawlers
 * use the directives), and the aipref formats are drafts with no
 * established consumer base either. TDMRep's weight in the EU is
 * legal (an express reservation of rights), not technical. The only
 * claim this module makes is FORMAT CONFORMANCE: the artifacts it
 * emits carry the host's declared choices in the cited formats.
 * Any deflection or protection percentage attributed to these
 * signals would be fabricated.
 *
 * The module declares the HOST's policy; it never imposes one.
 * Opting IN is fully expressible: `aiTrain: true` emits
 * `ai-train=yes` / `train-ai=y`, and `tdmReservation: false` emits
 * `tdm-reservation: 0`.
 *
 * Pure string/JSON generation: no I/O, no runtime dependencies.
 */

/** Host choices for the three declared uses. All three are required: the generator declares a complete policy. */
export interface PolicySignalChoices {
  /** Building a search index and returning results that link back to the source. */
  search: boolean;
  /** Inputting content into one or more AI models at answer time (retrieval / grounding for AI answers). */
  aiInput: boolean;
  /** Training or fine-tuning AI models on the content. */
  aiTrain: boolean;
}

export interface CreatePolicySignalsOptions {
  /**
   * Who to contact about this policy (an email address or a contact
   * URL, as a single line of text). Carried into the antiRea policy
   * JSON. Required.
   */
  contact: string;
  /**
   * Path scope the declarations apply to, as a robots-style path
   * prefix (must start with `/`). Used as the TDMRep rule
   * `location` and recorded in the policy JSON. Defaults to `/`
   * (the whole origin). The robots.txt signal lines themselves are
   * emitted unscoped inside their user-agent group.
   */
  scope?: string;
  /** The host's declared choices. */
  signals: PolicySignalChoices;
  /**
   * TDM rights reservation (TDMRep): `true` emits
   * `tdm-reservation: 1` (rights reserved), `false` emits
   * `tdm-reservation: 0` (not reserved, mining not opted out of).
   * Defaults to `!signals.aiTrain` - reserving when training is not
   * allowed, not reserving when it is.
   */
  tdmReservation?: boolean;
  /** URL of the host's TDM policy document (the TDMRep `tdm-policy` pointer). Optional. */
  tdmPolicyUrl?: string;
  /**
   * Optional host-defined pointer to the host's own agent policy
   * (a URL or identifier string). Passed through verbatim into the
   * antiRea policy JSON as `agentPolicy`; it is not part of any of
   * the cited formats.
   */
  agentPolicy?: string;
}

/** One rule object of the TDMRep `/.well-known/tdmrep.json` array (W3C TDMRep CG Final Report, 2024-05-10). */
export interface TdmRepRule {
  location: string;
  "tdm-reservation": 0 | 1;
  "tdm-policy"?: string;
}

/** The antiRea well-known policy document shape (antiRea's own design, not a standard). */
export interface AntiReaPolicyDocument {
  /** Document marker: this is an antiRea policy document, version 1 of its shape. */
  format: "antirea-policy";
  version: 1;
  contact: string;
  scope: string;
  /** The host's choices, in the Content-Signal vocabulary, exactly as emitted in robots.txt. */
  signals: {
    search: boolean;
    "ai-input": boolean;
    "ai-train": boolean;
  };
  /** The same choices in the current aipref draft vocabulary, exactly as emitted in the Content-Usage line. */
  contentUsage: {
    "train-ai": "y" | "n";
    "ai-use": "y" | "n";
    search: "y" | "n";
  };
  /** The TDMRep declaration, mirroring the single rule of `tdmrepJson()`. */
  tdm: {
    "tdm-reservation": 0 | 1;
    "tdm-policy"?: string;
  };
  /** Present only when the host passed `agentPolicy`. */
  agentPolicy?: string;
  /** Always `"none"`: this document declares a policy; it enforces nothing. */
  enforcement: "none";
  notice: string;
}

export interface PolicySignals {
  /**
   * The robots.txt group lines for `userAgent` (default `"*"`):
   * the `User-agent:` line, then the Content-Signal line, then the
   * Content-Usage line. Append them to the host's robots.txt under
   * the matching group (or use `robotsTxt()` for the block).
   */
  robotsTxtLines(userAgent?: string): string[];
  /** `robotsTxtLines()` joined as one robots.txt block, terminated by a newline. */
  robotsTxt(userAgent?: string): string;
  /**
   * The TDMRep document for `/.well-known/tdmrep.json`, as an
   * object: a JSON array holding exactly one rule for the declared
   * scope (the array form is mandatory per the CG report).
   */
  tdmrepJson(): TdmRepRule[];
  /** `tdmrepJson()` serialized (pretty-printed, trailing newline). */
  tdmrepJsonString(): string;
  /** The antiRea well-known policy document, as an object. */
  policyJson(): AntiReaPolicyDocument;
  /** `policyJson()` serialized (pretty-printed, trailing newline). */
  policyJsonString(): string;
  /**
   * Header forms of the same declarations, for hosts that attach
   * them per-response: the aipref draft's `Content-Usage` header
   * and TDMRep's `tdm-reservation` (plus `tdm-policy` when a policy
   * URL was given).
   */
  headers(): Record<string, string>;
}

/** Named error thrown for every invalid policy-signals input. */
export class PolicySignalsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicySignalsError";
  }
}

const fail = (message: string): never => {
  throw new PolicySignalsError(`createPolicySignals: ${message}`);
};

const hasControlOrNewline = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);

function requireSingleLine(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a non-empty string`);
  }
  if (hasControlOrNewline(value as string)) {
    fail(`${field} must be a single line (no control characters or newlines)`);
  }
  return value as string;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    fail(`${field} must be a boolean (true/false); got ${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
  }
  return value as boolean;
}

function requireHttpUrl(value: unknown, field: string): string {
  const text = requireSingleLine(value, field);
  let parsed: URL | undefined;
  try {
    parsed = new URL(text);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    fail(`${field} must be an absolute http(s) URL`);
  }
  return text;
}

const yesNo = (allowed: boolean): "yes" | "no" => (allowed ? "yes" : "no");
const yN = (allowed: boolean): "y" | "n" => (allowed ? "y" : "n");

/**
 * Create the generator for one host policy. All validation happens
 * here, up front: an instance that exists only ever emits
 * well-formed artifacts carrying exactly the choices it was given.
 */
export function createPolicySignals(options: CreatePolicySignalsOptions): PolicySignals {
  if (typeof options !== "object" || options === null) fail("options must be an object");
  const contact = requireSingleLine(options.contact, "contact");

  const scope = options.scope === undefined ? "/" : requireSingleLine(options.scope, "scope");
  if (!scope.startsWith("/")) fail('scope must be a path prefix starting with "/"');

  if (typeof options.signals !== "object" || options.signals === null) fail("signals must be an object");
  const signals: PolicySignalChoices = {
    search: requireBoolean(options.signals.search, "signals.search"),
    aiInput: requireBoolean(options.signals.aiInput, "signals.aiInput"),
    aiTrain: requireBoolean(options.signals.aiTrain, "signals.aiTrain"),
  };

  const tdmReservation =
    options.tdmReservation === undefined
      ? !signals.aiTrain
      : requireBoolean(options.tdmReservation, "tdmReservation");
  const tdmPolicyUrl =
    options.tdmPolicyUrl === undefined ? undefined : requireHttpUrl(options.tdmPolicyUrl, "tdmPolicyUrl");
  const agentPolicy =
    options.agentPolicy === undefined ? undefined : requireSingleLine(options.agentPolicy, "agentPolicy");

  const contentSignalLine = (): string =>
    `Content-Signal: search=${yesNo(signals.search)}, ai-input=${yesNo(signals.aiInput)}, ai-train=${yesNo(signals.aiTrain)}`;

  const contentUsageValue = (): string =>
    `train-ai=${yN(signals.aiTrain)}, ai-use=${yN(signals.aiInput)}, search=${yN(signals.search)}`;

  const tdmrepJson = (): TdmRepRule[] => [
    {
      location: scope,
      "tdm-reservation": tdmReservation ? 1 : 0,
      ...(tdmPolicyUrl ? { "tdm-policy": tdmPolicyUrl } : {}),
    },
  ];

  const policyJson = (): AntiReaPolicyDocument => ({
    format: "antirea-policy",
    version: 1,
    contact,
    scope,
    signals: {
      search: signals.search,
      "ai-input": signals.aiInput,
      "ai-train": signals.aiTrain,
    },
    contentUsage: {
      "train-ai": yN(signals.aiTrain),
      "ai-use": yN(signals.aiInput),
      search: yN(signals.search),
    },
    tdm: {
      "tdm-reservation": tdmReservation ? 1 : 0,
      ...(tdmPolicyUrl ? { "tdm-policy": tdmPolicyUrl } : {}),
    },
    ...(agentPolicy ? { agentPolicy } : {}),
    enforcement: "none",
    notice:
      "Declaration only: this document states the host's content-use policy in machine-readable " +
      "formats. It enforces nothing and blocks nothing; the signals bind only agents that choose " +
      "to honor them.",
  });

  const robotsTxtLines = (userAgent: string = "*"): string[] => {
    const agent = requireSingleLine(userAgent, "userAgent");
    return [`User-agent: ${agent}`, contentSignalLine(), `Content-Usage: ${contentUsageValue()}`];
  };

  return {
    robotsTxtLines,
    robotsTxt(userAgent: string = "*"): string {
      return `${robotsTxtLines(userAgent).join("\n")}\n`;
    },
    tdmrepJson,
    tdmrepJsonString(): string {
      return `${JSON.stringify(tdmrepJson(), null, 2)}\n`;
    },
    policyJson,
    policyJsonString(): string {
      return `${JSON.stringify(policyJson(), null, 2)}\n`;
    },
    headers(): Record<string, string> {
      return {
        "Content-Usage": contentUsageValue(),
        "tdm-reservation": tdmReservation ? "1" : "0",
        ...(tdmPolicyUrl ? { "tdm-policy": tdmPolicyUrl } : {}),
      };
    },
  };
}
