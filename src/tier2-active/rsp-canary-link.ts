/**
 * RSP-07: Canary link tracking tokens (opt-in, default OFF).
 *
 * Honeypot-surface only, advisory, low tier. Per-IP, per-label tokens
 * (16 hex chars of an HMAC-SHA256 of (ip, label)); a click attributes
 * to the exact (label, IP) from the token alone, with no join.
 *
 * Measured in the RSP Step-0 lab: tokens distinct per IP 64/64 and
 * per label 12/12; 500/500 simulated clicks attributed exactly.
 *
 * Recorded caveat (binding documentation): the token binds (ip, label)
 * at ISSUANCE only. A token presented from a different IP is still
 * logged under the issuing IP (50/50 cross-IP presentations in the
 * lab). Hosts must treat attribution as "the surface this token was
 * issued into was copied or followed", never as proof of who clicked.
 * This module is inert until a host constructs it; a click label is
 * never a sole blocking key.
 */
import { rspHmacHex } from "../internal/rsp-crypto";

export const RSP_CANARY_LABELS = [
  "Dashboard", "Posts", "Media", "Pages", "Comments", "Appearance",
  "Plugins", "Users", "Tools", "Settings", "Plugin Editor", "Theme Editor",
] as const;

export interface RspCanaryLinks {
  token(ip: string, label: string): string;
  issue(ip: string, labels?: readonly string[]): Map<string, { ip: string; label: string }>;
  resolve(token: string): { ip: string; label: string } | null;
  attributeClick(token: string, presenterIp?: string): { ip: string; label: string; presenterIp: string | null; loggedUnderIssuingIp: boolean } | null;
}

export function createRspCanaryLinks(options: { secret: string | Uint8Array }): RspCanaryLinks {
  const secret = options.secret;
  const issued = new Map<string, { ip: string; label: string }>();

  function token(ip: string, label: string): string {
    return rspHmacHex(secret, ip + "\n" + label).slice(0, 16);
  }
  function issue(ip: string, labels: readonly string[] = RSP_CANARY_LABELS) {
    for (const label of labels) issued.set(token(ip, label), { ip, label });
    return issued;
  }
  function resolve(t: string) {
    return issued.get(t) ?? null;
  }
  function attributeClick(t: string, presenterIp?: string) {
    const row = issued.get(t);
    if (!row) return null;
    return {
      ip: row.ip,
      label: row.label,
      presenterIp: presenterIp ?? null,
      loggedUnderIssuingIp: presenterIp !== undefined && presenterIp !== row.ip,
    };
  }
  return { token, issue, resolve, attributeClick };
}
