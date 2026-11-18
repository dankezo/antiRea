/**
 * RSP-10: Fabricated SQLi dump (opt-in decoy content).
 *
 * Per-IP disjoint fake wp_users pairs inside an error page, served
 * only for SQLi-shaped POSTs; benign POSTs draw no dump.
 *
 * Placement, corrected from the lab (defect 1): the visible XPATH
 * error line is truncated to 31 chars and contains 0 complete pairs;
 * all 5 pairs are fully visible only inside an HTML comment. This
 * build follows the corrected placement exactly.
 *
 * Measured in the RSP Step-0 lab: 64 IPs produce pairwise-disjoint
 * username sets; benign POSTs 32/32 draw no dump; 0 cracks in 128
 * dictionary words against all 5 hashes of one IP (hashes are
 * HMAC-derived, not dictionary passwords). Usernames attribute to
 * the reading IP 64/64. Honeypot-surface only, advisory, low tier.
 */
import { rspHmac, rspHmacHex } from "../internal/rsp-crypto";

const WORDS = ["alpha", "bravo", "cedar", "delta", "ember", "fjord", "glade", "harbor", "iris", "juniper", "keel", "lumen", "maple", "north", "onyx", "pine", "quartz", "ridge", "solar", "tundra"];

export interface RspSqliPair { username: string; hash: string }

export function rspSqliPairs(secret: string | Uint8Array, ip: string): RspSqliPair[] {
  const pairs: RspSqliPair[] = [];
  for (let i = 0; i < 5; i++) {
    const h = rspHmac(secret, `rsp10\n${ip}\n${i}`);
    const word = WORDS[h[0]! % WORDS.length]!;
    const username = `${word}_${rspHmacHex(secret, `rsp10-user\n${ip}\n${i}`).slice(0, 6)}`;
    const hash = "$P$B" + rspHmacHex(secret, `rsp10-hash\n${ip}\n${i}`).slice(0, 30);
    pairs.push({ username, hash });
  }
  return pairs;
}

export function rspIsSqliShaped(body: string): boolean {
  const b = body.toLowerCase();
  return b.includes("'") && (b.includes("union") || b.includes("select") || b.includes(" or ") || b.includes("extractvalue") || b.includes("updatexml") || b.includes("--"));
}

export interface RspSqliPage { body: string; visibleLine: string; pairs: RspSqliPair[]; dumped: boolean }

export function rspSqliErrorPage(secret: string | Uint8Array, ip: string, postBody: string): RspSqliPage {
  if (!rspIsSqliShaped(postBody)) {
    return { body: "<html><body><p>Request processed.</p></body></html>", visibleLine: "", pairs: [], dumped: false };
  }
  const pairs = rspSqliPairs(secret, ip);
  const joined = pairs.map((p) => `${p.username}:${p.hash}`).join("~");
  const visibleLine = ("XPATH syntax error: '" + joined).slice(0, 31);
  const comment = pairs.map((p) => `${p.username} ${p.hash}`).join("\n");
  const body = `<html><body><p>${visibleLine}</p><!--\n${comment}\n--></body></html>`;
  return { body, visibleLine, pairs, dumped: true };
}
