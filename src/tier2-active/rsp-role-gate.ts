/**
 * RSP-11: Privilege-escalation role gate (opt-in honeypot capture rule).
 *
 * Registers form submissions whose role field claims an admin-level
 * role: the role VALUE is lowercased and substring-matched against
 * admin / editor / level_10 across the role, user_role, new_role and
 * wp_capabilities fields (a serialized wp_capabilities value
 * containing "administrator" is caught). Registration also requires
 * a parsed user and password field; a pair without a role claim is
 * still captured, just not registered.
 *
 * Measured in the RSP Step-0 lab: positives 6/6, case forms 2/2,
 * serialized capabilities caught, negatives 4/4.
 *
 * Recorded gap (binding documentation): the parser is form-encoded
 * only. The same escalation sent as JSON registers 0 - the form
 * parser cannot see it. Hosts must not treat a non-registration as
 * evidence a submission was benign.
 * Honeypot-surface only, advisory, low tier.
 */
const ROLE_FIELDS = ["role", "user_role", "wp_capabilities", "new_role"];
const USER_FIELDS = ["user_login", "username", "user_name", "log", "new_user"];
const PASS_FIELDS = ["user_pass", "password", "user_password", "pwd", "pass"];

function percentDecode(s: string): string {
  try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; }
}

export function rspExtractFormField(body: string, field: string): string | null {
  for (const pair of body.split("&")) {
    const eq = pair.indexOf("=");
    const name = eq < 0 ? pair : pair.slice(0, eq);
    if (name === field) return percentDecode(eq < 0 ? "" : pair.slice(eq + 1));
  }
  return null;
}

export function rspIsPrivilegeEscalation(body: string): boolean {
  return ROLE_FIELDS.some((f) => {
    const v = rspExtractFormField(body, f);
    if (v === null) return false;
    const lv = v.toLowerCase();
    return lv.includes("admin") || lv.includes("editor") || lv.includes("level_10");
  });
}

export function rspParseCreatedAccount(body: string): { user: string | null; pass: string | null } {
  const user = USER_FIELDS.map((f) => rspExtractFormField(body, f)).find((v) => v !== null) ?? null;
  const pass = PASS_FIELDS.map((f) => rspExtractFormField(body, f)).find((v) => v !== null) ?? null;
  return { user, pass };
}

export interface RspRoleGateResult { captured: boolean; registered: boolean; user: string | null }

export function rspRoleGate(body: string): RspRoleGateResult {
  const { user, pass } = rspParseCreatedAccount(body);
  const captured = user !== null && pass !== null;
  return { captured, registered: captured && rspIsPrivilegeEscalation(body), user };
}
