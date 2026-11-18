/**
 * RSP-17: Cookie bomb on first grant, SIZED TO A MEASURED SAFE BUDGET.
 *
 * The lab form (20 cookies x 400 chars) produces a first-grant
 * Set-Cookie block of 8,868 bytes, above the common 8 KiB proxy
 * header ceiling: the bomb can be truncated or rejected by the very
 * infrastructure it targets (lab defect 7). This build therefore
 * sizes the bomb against an explicit byte budget: the total
 * Set-Cookie block never exceeds the configured budget (default
 * 7,168 bytes, comfortably under 8,192), and the per-cookie size is
 * derived from the budget, never the other way round. Cookies
 * attach on the first grant only; count 0 or size 0 disables.
 *
 * Measured in the RSP Step-0 lab: first grant attaches exactly 20
 * bomb cookies plus 2 session cookies; grants 1 and 5 attach 0;
 * non-recordable POSTs never reach attach.
 * Honeypot-surface only, advisory, low tier.
 */
export const RSP_COOKIE_BOMB_DEFAULT_BUDGET_BYTES = 7168;
export const RSP_PROXY_HEADER_CEILING_BYTES = 8192;

export interface RspCookieBomb {
  attach(input: { grantIndex: number; recordable: boolean }): { headers: string[]; totalBytes: number; bombCookies: number };
  budgetBytes: number;
  count: number;
  cookieSize: number;
}

export function createRspCookieBomb(options?: { count?: number; size?: number; budgetBytes?: number }): RspCookieBomb {
  const count = Math.max(0, Math.floor(options?.count ?? 20) || 0);
  const budgetBytes = Math.min(
    Math.max(0, Math.floor(options?.budgetBytes ?? RSP_COOKIE_BOMB_DEFAULT_BUDGET_BYTES) || 0),
    RSP_PROXY_HEADER_CEILING_BYTES - 1,
  );
  const requestedSize = Math.max(0, Math.floor(options?.size ?? 400) || 0);
  // Per-cookie line overhead: name (up to 8) + "; Path=/; HttpOnly" (18) + CRLF (2) = 28.
  // The 2 session cookie lines (31 bytes each with CRLF) also count against the budget.
  const overheadPerCookie = 28;
  const sessionBytes = 62;
  const sizeByBudget = count > 0 ? Math.max(0, Math.floor((budgetBytes - sessionBytes) / count) - overheadPerCookie) : 0;
  const cookieSize = Math.min(requestedSize, sizeByBudget);

  function attach(input: { grantIndex: number; recordable: boolean }) {
    if (!input.recordable || input.grantIndex !== 0 || count === 0 || cookieSize === 0) {
      return { headers: [] as string[], totalBytes: 0, bombCookies: 0 };
    }
    const headers: string[] = [];
    for (let i = 0; i < count; i++) headers.push(`bomb_${i}=${"x".repeat(cookieSize)}; Path=/; HttpOnly`);
    headers.push("session_a=1; Path=/; HttpOnly", "session_b=1; Path=/; HttpOnly");
    const totalBytes = headers.reduce((sum, h) => sum + h.length + 2, 0); // + CRLF per header line
    return { headers, totalBytes, bombCookies: count };
  }
  return { attach, budgetBytes, count, cookieSize };
}
