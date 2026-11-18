/**
 * C2 IP radix deny table (NHS-04, antiRea 3.1.0).
 *
 * WHAT IT IS. A standalone longest-prefix-match lookup over a
 * host-supplied IP/CIDR deny list, for IPv4 and IPv6. The host owns
 * the list; this module owns only the matching property: when two
 * entries cover a query address, the entry with the LONGEST prefix
 * wins (a /32 beats its covering /24). The radix tree of the source
 * is an implementation detail; longest-prefix exactness is the
 * measured property and is what this port guarantees.
 *
 * FAIL OPEN, BY DESIGN. A query that is not a parseable IP returns
 * null (never throws), an address outside every entry returns null,
 * and an empty table matches nothing. There is no FP surface beyond
 * list quality: the module flags exactly the addresses the host's
 * entries cover, at the longest covering prefix.
 *
 * CONFIG ERRORS ARE LOUD. An entry whose CIDR does not parse throws
 * a TypeError at construction: a silently dropped deny entry is a
 * hole the host would never notice, so construction refuses it.
 *
 * LAB EVIDENCE (Step-0, nhs-lab/nhs04.cjs, RESULTS-NHS-STEP0.md).
 * The /32 entry wins over its covering /24; one-bit-outside and
 * outside-/24 queries miss; an IPv6 /32 entry matches its range;
 * non-IP inputs ("unix:/var/run/sock", empty) return null without
 * throwing; the empty table fails open.
 */

export interface IpDenyEntry {
  /** CIDR notation, e.g. "198.51.100.0/24" or "2001:db8::/32". */
  cidr: string;
  /** Host-chosen identifier returned on a match. */
  id: string;
}

export interface IpDenyMatch {
  id: string;
  cidr: string;
  prefixLength: number;
}

interface ParsedIp {
  v: bigint;
  bits: 32 | 128;
}
interface ParsedCidr extends ParsedIp {
  len: number;
}

function parseIp(ip: unknown): ParsedIp | null {
  if (typeof ip !== "string" || ip.length === 0) return null;
  if (ip.includes(":")) {
    let head = ip;
    let tail = "";
    const dc = ip.indexOf("::");
    if (dc >= 0) {
      head = ip.slice(0, dc);
      tail = ip.slice(dc + 2);
    }
    const hg = head === "" ? [] : head.split(":");
    const tg = tail === "" ? [] : tail.split(":");
    if (dc < 0 && hg.length !== 8) return null;
    if (dc >= 0 && hg.length + tg.length > 7) return null;
    const groups: number[] = [];
    for (const g of hg) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    const fill = 8 - hg.length - tg.length;
    for (let i = 0; i < fill; i++) groups.push(0);
    for (const g of tg) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    if (groups.length !== 8) return null;
    let v = 0n;
    for (const g of groups) v = (v << 16n) | BigInt(g);
    return { v, bits: 128 };
  }
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let v = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    v = (v << 8n) | BigInt(n);
  }
  return { v, bits: 32 };
}

function parseCidr(cidr: string): ParsedCidr | null {
  const slash = cidr.lastIndexOf("/");
  if (slash < 0) return null;
  const a = parseIp(cidr.slice(0, slash));
  if (!a) return null;
  const len = Number(cidr.slice(slash + 1));
  if (!Number.isInteger(len) || len < 0 || len > a.bits) return null;
  return { ...a, len };
}

/**
 * Create a longest-prefix deny table. Opt-in standalone utility:
 * lookups are pure and keep no per-query state.
 */
export function createIpDenyTable(entries: readonly IpDenyEntry[] = []): {
  lookup(ip: string): IpDenyMatch | null;
  size(): number;
} {
  const parsed: Array<ParsedCidr & IpDenyEntry> = [];
  for (const e of entries) {
    const p = typeof e?.cidr === "string" ? parseCidr(e.cidr) : null;
    if (!p || typeof e.id !== "string" || e.id.length === 0) {
      throw new TypeError(`ip deny table: invalid entry ${JSON.stringify(e)}`);
    }
    parsed.push({ ...p, cidr: e.cidr, id: e.id });
  }
  function lookup(ip: string): IpDenyMatch | null {
    const q = parseIp(ip);
    if (!q) return null;
    let best: (ParsedCidr & IpDenyEntry) | null = null;
    for (const e of parsed) {
      if (e.bits !== q.bits) continue;
      const shift = BigInt(e.bits - e.len);
      if ((q.v >> shift) === (e.v >> shift)) {
        if (!best || e.len > best.len) best = e;
      }
    }
    return best ? { id: best.id, cidr: best.cidr, prefixLength: best.len } : null;
  }
  return { lookup, size: () => parsed.length };
}
