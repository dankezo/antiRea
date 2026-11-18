/**
 * Filter expression language (WDN-11, WebDecoy filter port) - a
 * standalone, opt-in parser/evaluator module for rule expressions.
 *
 * Grammar: or / and / not (the language spells conjunction "and" -
 * there is no && token, and using one throws at parse time),
 * comparisons ==, !=, >, >=, <, <=, in, not in, matches; literals
 * (strings, numbers, booleans, arrays); property paths in the ip /
 * req / bot / edge namespaces; and req.header('name') calls.
 *
 * Frozen semantics, measured in the WDN Step-0 lab (wdn-lab/wdn11.cjs):
 * - bot.category == 'training_crawler' fires on the GPTBot context and
 *   not on the browser context;
 * - an expression reading ip.* with NO enrichment reports NOT_RUN
 *   through the filter rule (WDN-09 taxonomy) - never a silent false;
 *   with enrichment present it evaluates normally;
 * - req.path matches '^/api/' is true on /api/x;
 * - the regex cap is a hard bound at exactly 500 chars: a 501-char
 *   pattern that would match evaluates false, the same construction
 *   at exactly 500 evaluates true;
 * - undefined comparisons fail open false, never match (an unknown
 *   bot's organization compared to 'OpenAI' is false);
 * - a truncated expression throws a parse Error at construction
 *   (fail fast, no evaluation).
 *
 * Integration boundary (binding): this module is NOT wired into any
 * evaluate() path. It ships standalone so a host can build its own
 * rules on it; the filter rule's result shape is compatible with the
 * WDN-09 taxonomy (state NOT_RUN surfaces verbatim through
 * toRuleOutcome). Regexes are host-supplied configuration, evaluated
 * with the platform RegExp under the 500-char cap - the cap bounds
 * pattern size, not worst-case match time, and hosts should treat
 * expressions as trusted config, never as client input.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

/** Hard cap on `matches` pattern length (lab-frozen). */
export const MAX_FILTER_REGEX_LENGTH = 500;

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

type TokenType =
  | "IDENT" | "STRING" | "NUMBER" | "BOOL" | "AND" | "OR" | "NOT"
  | "EQ" | "NEQ" | "GT" | "GTE" | "LT" | "LTE" | "IN" | "MATCHES"
  | "DOT" | "LPAREN" | "RPAREN" | "LBRACKET" | "RBRACKET" | "COMMA" | "EOF";

interface Token {
  type: TokenType;
  value: string;
  position: number;
}

const KEYWORDS: Record<string, TokenType> = {
  and: "AND", or: "OR", not: "NOT", in: "IN", matches: "MATCHES", true: "BOOL", false: "BOOL",
};

class Tokenizer {
  private pos = 0;
  private readonly tokens: Token[] = [];
  constructor(private readonly source: string) {}

  tokenize(): Token[] {
    while (this.pos < this.source.length) {
      this.skipWhitespace();
      if (this.pos >= this.source.length) break;
      const ch = this.source[this.pos]!;
      if (ch === ".") { this.push("DOT", "."); this.pos++; continue; }
      if (ch === "(") { this.push("LPAREN", "("); this.pos++; continue; }
      if (ch === ")") { this.push("RPAREN", ")"); this.pos++; continue; }
      if (ch === "[") { this.push("LBRACKET", "["); this.pos++; continue; }
      if (ch === "]") { this.push("RBRACKET", "]"); this.pos++; continue; }
      if (ch === ",") { this.push("COMMA", ","); this.pos++; continue; }
      if (ch === "=" && this.peek(1) === "=") { this.push("EQ", "=="); this.pos += 2; continue; }
      if (ch === "!" && this.peek(1) === "=") { this.push("NEQ", "!="); this.pos += 2; continue; }
      if (ch === ">" && this.peek(1) === "=") { this.push("GTE", ">="); this.pos += 2; continue; }
      if (ch === "<" && this.peek(1) === "=") { this.push("LTE", "<="); this.pos += 2; continue; }
      if (ch === ">") { this.push("GT", ">"); this.pos++; continue; }
      if (ch === "<") { this.push("LT", "<"); this.pos++; continue; }
      if (ch === '"' || ch === "'") { this.readString(ch); continue; }
      if (this.isDigit(ch) || (ch === "-" && this.isDigit(this.peek(1)))) { this.readNumber(); continue; }
      if (this.isIdentStart(ch)) { this.readIdent(); continue; }
      throw new Error(`Unexpected character '${ch}' at position ${this.pos}`);
    }
    this.tokens.push({ type: "EOF", value: "", position: this.pos });
    return this.tokens;
  }

  private push(type: TokenType, value: string): void {
    this.tokens.push({ type, value, position: this.pos });
  }
  private peek(offset: number): string {
    const idx = this.pos + offset;
    return idx < this.source.length ? this.source[idx]! : "";
  }
  private skipWhitespace(): void {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos]!)) this.pos++;
  }
  private readString(quote: string): void {
    const start = this.pos;
    this.pos++;
    let value = "";
    while (this.pos < this.source.length && this.source[this.pos] !== quote) {
      if (this.source[this.pos] === "\\") this.pos++;
      value += this.source[this.pos];
      this.pos++;
    }
    if (this.pos >= this.source.length) throw new Error(`Unterminated string at position ${start}`);
    this.pos++;
    this.tokens.push({ type: "STRING", value, position: start });
  }
  private readNumber(): void {
    const start = this.pos;
    if (this.source[this.pos] === "-") this.pos++;
    while (this.pos < this.source.length && this.isDigit(this.source[this.pos]!)) this.pos++;
    if (this.pos < this.source.length && this.source[this.pos] === ".") {
      this.pos++;
      while (this.pos < this.source.length && this.isDigit(this.source[this.pos]!)) this.pos++;
    }
    this.tokens.push({ type: "NUMBER", value: this.source.slice(start, this.pos), position: start });
  }
  private readIdent(): void {
    const start = this.pos;
    while (this.pos < this.source.length && this.isIdentPart(this.source[this.pos]!)) this.pos++;
    const value = this.source.slice(start, this.pos);
    const keyword = KEYWORDS[value.toLowerCase()];
    if (keyword) this.tokens.push({ type: keyword, value: value.toLowerCase(), position: start });
    else this.tokens.push({ type: "IDENT", value, position: start });
  }
  private isDigit(ch: string): boolean { return ch >= "0" && ch <= "9"; }
  private isIdentStart(ch: string): boolean { return /[a-zA-Z_]/.test(ch); }
  private isIdentPart(ch: string): boolean { return /[a-zA-Z0-9_]/.test(ch); }
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

export type FilterAst =
  | { kind: "bool"; value: boolean }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "array"; elements: FilterAst[] }
  | { kind: "property"; path: string[] }
  | { kind: "call"; object: string[]; method: string; args: FilterAst[] }
  | { kind: "unary"; op: "not"; operand: FilterAst }
  | { kind: "binary"; op: string; left: FilterAst; right: FilterAst };

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(source: string) {
    this.tokens = new Tokenizer(source).tokenize();
  }

  parse(): FilterAst {
    const ast = this.orExpr();
    this.expect("EOF", "Expected end of expression");
    return ast;
  }

  private orExpr(): FilterAst {
    let left = this.andExpr();
    while (this.match("OR")) left = { kind: "binary", op: "or", left, right: this.andExpr() };
    return left;
  }
  private andExpr(): FilterAst {
    let left = this.unary();
    while (this.match("AND")) left = { kind: "binary", op: "and", left, right: this.unary() };
    return left;
  }
  private unary(): FilterAst {
    if (this.match("NOT")) {
      if (this.check("IN")) {
        this.pos--;
        return this.comparison();
      }
      return { kind: "unary", op: "not", operand: this.unary() };
    }
    return this.comparison();
  }
  private comparison(): FilterAst {
    const left = this.primary();
    if (this.match("EQ")) return { kind: "binary", op: "==", left, right: this.primary() };
    if (this.match("NEQ")) return { kind: "binary", op: "!=", left, right: this.primary() };
    if (this.match("GT")) return { kind: "binary", op: ">", left, right: this.primary() };
    if (this.match("GTE")) return { kind: "binary", op: ">=", left, right: this.primary() };
    if (this.match("LT")) return { kind: "binary", op: "<", left, right: this.primary() };
    if (this.match("LTE")) return { kind: "binary", op: "<=", left, right: this.primary() };
    if (this.match("IN")) return { kind: "binary", op: "in", left, right: this.primary() };
    if (this.match("MATCHES")) return { kind: "binary", op: "matches", left, right: this.primary() };
    if (this.check("NOT") && this.checkAhead("IN")) {
      this.advance();
      this.advance();
      return { kind: "binary", op: "not in", left, right: this.primary() };
    }
    return left;
  }
  private primary(): FilterAst {
    if (this.check("BOOL")) return { kind: "bool", value: this.advance().value === "true" };
    if (this.check("NUMBER")) return { kind: "number", value: parseFloat(this.advance().value) };
    if (this.check("STRING")) return { kind: "string", value: this.advance().value };
    if (this.match("LBRACKET")) {
      const elements: FilterAst[] = [];
      if (!this.check("RBRACKET")) {
        elements.push(this.primary());
        while (this.match("COMMA")) elements.push(this.primary());
      }
      this.expect("RBRACKET", 'Expected "]"');
      return { kind: "array", elements };
    }
    if (this.match("LPAREN")) {
      const expr = this.orExpr();
      this.expect("RPAREN", 'Expected ")"');
      return expr;
    }
    if (this.check("IDENT")) {
      const path = [this.advance().value];
      while (this.match("DOT")) {
        if (!this.check("IDENT")) {
          throw new Error(`Expected identifier after "." at position ${this.current().position}`);
        }
        path.push(this.advance().value);
      }
      if (this.match("LPAREN")) {
        const method = path.pop()!;
        const args: FilterAst[] = [];
        if (!this.check("RPAREN")) {
          args.push(this.primary());
          while (this.match("COMMA")) args.push(this.primary());
        }
        this.expect("RPAREN", 'Expected ")"');
        return { kind: "call", object: path, method, args };
      }
      return { kind: "property", path };
    }
    throw new Error(`Unexpected token "${this.current().value}" at position ${this.current().position}`);
  }

  private current(): Token { return this.tokens[this.pos]!; }
  private advance(): Token { return this.tokens[this.pos++]!; }
  private check(type: TokenType): boolean { return this.current().type === type; }
  private checkAhead(type: TokenType): boolean {
    return this.pos + 1 < this.tokens.length && this.tokens[this.pos + 1]!.type === type;
  }
  private match(type: TokenType): boolean {
    if (this.check(type)) {
      this.advance();
      return true;
    }
    return false;
  }
  private expect(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    throw new Error(`${message}, got "${this.current().value}" at position ${this.current().position}`);
  }
}

/** Parse a filter expression. Throws an Error on any malformed input (fail fast, at construction). */
export function parseFilterExpression(source: string): FilterAst {
  return new Parser(source).parse();
}

/* ------------------------------------------------------------------ */
/* Evaluator                                                           */
/* ------------------------------------------------------------------ */

export interface FilterBotContext {
  known: boolean;
  id?: string;
  name?: string;
  category?: string;
  organization?: string;
  score?: number;
  respectsRobots?: boolean;
  isAI?: boolean;
}

export interface FilterEnrichment {
  security: { vpn: boolean; proxy: boolean; tor: boolean; relay: boolean; hosting: boolean };
  location: { country: string; country_name: string; city: string; timezone: string };
  network: { asn: number; asn_org: string };
  reputation: { abuse_score: number; total_reports: number; is_high_risk: boolean };
}

export interface FilterEdgeContext {
  present: boolean;
  clearance?: string;
  class?: string;
  isVerified?: boolean;
  isCrawler?: boolean;
  isScript?: boolean;
  isBrowser?: boolean;
}

export interface FilterContext {
  path?: string;
  method?: string;
  ip?: string;
  userAgent?: string;
  headers?: Record<string, string | undefined>;
  bot?: FilterBotContext;
  enrichment?: FilterEnrichment;
  edge?: FilterEdgeContext;
}

function resolveProperty(path: string[], context: FilterContext): unknown {
  const namespace = path[0];
  const prop = path.slice(1).join(".");
  if (namespace === "ip") {
    const e = context.enrichment;
    if (!e) return undefined;
    if (prop === "vpn") return e.security.vpn;
    if (prop === "proxy") return e.security.proxy;
    if (prop === "tor") return e.security.tor;
    if (prop === "relay") return e.security.relay;
    if (prop === "hosting") return e.security.hosting;
    if (prop === "country") return e.location.country;
    if (prop === "country_name") return e.location.country_name;
    if (prop === "city") return e.location.city;
    if (prop === "timezone") return e.location.timezone;
    if (prop === "asn") return e.network.asn;
    if (prop === "asn_org") return e.network.asn_org;
    if (prop === "abuse_score") return e.reputation.abuse_score;
    if (prop === "total_reports") return e.reputation.total_reports;
    if (prop === "is_high_risk") return e.reputation.is_high_risk;
    return undefined;
  }
  if (namespace === "req") {
    if (prop === "path") return context.path;
    if (prop === "method") return context.method;
    if (prop === "ip") return context.ip;
    if (prop === "user_agent") return context.userAgent;
    return undefined;
  }
  if (namespace === "edge") {
    const e = context.edge;
    if (!e) return undefined;
    if (prop === "present") return e.present;
    if (prop === "clearance") return e.clearance;
    if (prop === "class") return e.class;
    if (prop === "verified") return e.isVerified;
    if (prop === "crawler") return e.isCrawler;
    if (prop === "script") return e.isScript;
    if (prop === "browser") return e.isBrowser;
    return undefined;
  }
  if (namespace === "bot") {
    const b = context.bot;
    if (!b) return undefined;
    if (prop === "known") return b.known;
    if (prop === "ai") return b.isAI;
    if (!b.known) return undefined;
    if (prop === "id") return b.id;
    if (prop === "name") return b.name;
    if (prop === "category") return b.category;
    if (prop === "organization") return b.organization;
    if (prop === "score") return b.score;
    if (prop === "respects_robots") return b.respectsRobots;
    return undefined;
  }
  return undefined;
}

function resolveCall(object: string[], method: string, args: FilterAst[], context: FilterContext): unknown {
  if (object[0] === "req" && method === "header") {
    if (args.length !== 1) return undefined;
    const headerName = evaluateFilterAst(args[0]!, context);
    if (typeof headerName !== "string") return undefined;
    return context.headers?.[headerName.toLowerCase()];
  }
  return undefined;
}

function evaluateBinary(op: string, left: FilterAst, right: FilterAst, context: FilterContext): unknown {
  if (op === "and") {
    const l = evaluateFilterAst(left, context);
    if (l === undefined || l === false) return false;
    const r = evaluateFilterAst(right, context);
    if (r === undefined) return false;
    return !!r;
  }
  if (op === "or") {
    const l = evaluateFilterAst(left, context);
    if (l === undefined ? false : !!l) return true;
    const r = evaluateFilterAst(right, context);
    if (r === undefined) return false;
    return !!r;
  }
  const l = evaluateFilterAst(left, context);
  const r = evaluateFilterAst(right, context);
  if (l === undefined || r === undefined) return false;
  switch (op) {
    case "==": return l === r;
    case "!=": return l !== r;
    case ">": return typeof l === "number" && typeof r === "number" && l > r;
    case ">=": return typeof l === "number" && typeof r === "number" && l >= r;
    case "<": return typeof l === "number" && typeof r === "number" && l < r;
    case "<=": return typeof l === "number" && typeof r === "number" && l <= r;
    case "in": return Array.isArray(r) ? r.includes(l) : false;
    case "not in": return Array.isArray(r) ? !r.includes(l) : false;
    case "matches": {
      if (typeof l !== "string" || typeof r !== "string") return false;
      if (r.length > MAX_FILTER_REGEX_LENGTH) return false;
      try {
        return new RegExp(r).test(l);
      } catch {
        return false;
      }
    }
    default: return false;
  }
}

/** Evaluate a parsed expression against a context. Undefined comparisons evaluate false. */
export function evaluateFilterAst(node: FilterAst, context: FilterContext): unknown {
  switch (node.kind) {
    case "bool": return node.value;
    case "number": return node.value;
    case "string": return node.value;
    case "array": return node.elements.map((el) => evaluateFilterAst(el, context));
    case "property": return resolveProperty(node.path, context);
    case "call": return resolveCall(node.object, node.method, node.args, context);
    case "unary": {
      const val = evaluateFilterAst(node.operand, context);
      if (val === undefined) return false;
      return !val;
    }
    case "binary": return evaluateBinary(node.op, node.left, node.right, context);
  }
}

/** Parse and evaluate in one call. Throws on a malformed expression, like parseFilterExpression. */
export function evaluateFilterExpression(source: string, context: FilterContext): unknown {
  return evaluateFilterAst(parseFilterExpression(source), context);
}

/* ------------------------------------------------------------------ */
/* Filter rule (NOT_RUN semantics, WDN-09 compatible result shape)     */
/* ------------------------------------------------------------------ */

export interface FilterRuleResult {
  action: "ALLOW" | "DENY" | "CHALLENGE";
  rule: string;
  state?: "NOT_RUN";
  reason?: string;
  metadata?: { expression: string; dryRun: boolean };
}

export interface FilterRule {
  readonly name: string;
  readonly expression: string;
  evaluate(context: FilterContext): FilterRuleResult;
}

/**
 * Create a filter rule from an expression. The constructor parses
 * eagerly and throws on a malformed expression. Evaluation reports
 * NOT_RUN when the expression reads ip.* and the context carries no
 * enrichment; a truthy evaluation fires the configured action (ALLOW
 * with dryRun metadata in dry-run mode).
 */
export function createFilterRule(config: {
  expression: string;
  action?: "ALLOW" | "DENY" | "CHALLENGE";
  dryRun?: boolean;
}): FilterRule {
  const ast = parseFilterExpression(config.expression);
  const action = config.action ?? "DENY";
  const dryRun = config.dryRun ?? false;
  const name = `filter:${config.expression.slice(0, 50)}`;
  return {
    name,
    expression: config.expression,
    evaluate(context: FilterContext): FilterRuleResult {
      if (!context.enrichment && config.expression.includes("ip.")) {
        return {
          action: "ALLOW",
          rule: name,
          state: "NOT_RUN",
          reason: "No IP enrichment available - filter needs enrichment",
        };
      }
      const result = evaluateFilterAst(ast, context);
      if (result) {
        return {
          action: dryRun ? "ALLOW" : action,
          rule: name,
          reason: `Filter matched: ${config.expression}`,
          metadata: { expression: config.expression, dryRun },
        };
      }
      return { action: "ALLOW", rule: name };
    },
  };
}
