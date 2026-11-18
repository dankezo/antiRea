/**
 * trustProxy XFF resolution (WDN-10, WebDecoy client-ip port) - an
 * opt-in resolver utility.
 *
 * Client-IP resolution counts trust from the RIGHT of the forwarding
 * chain - never the client-written leftmost value. Modes:
 * - trustProxy false / 0: return the connection peer, always.
 * - trustProxy N (number): return the chain entry N hops from the
 *   right (1 = the last entry, the one the innermost trusted proxy
 *   recorded).
 * - trustProxy "cloudflare": return CF-Connecting-IP (falling back to
 *   the peer when absent or malformed).
 * - trustProxy "railway": exactly trustProxy 2.
 * - trustProxy CIDR list: walk the chain plus peer from the right,
 *   skipping trusted entries; STOP at a malformed entry and return
 *   the peer - a valid-looking value left of garbage is never
 *   believed.
 * Normalization: IPv4-mapped IPv6 collapses to IPv4 in both peer and
 * chain positions; leading-zero IPv4 (01.2.3.4) is rejected and
 * resolution falls back to the peer; bracketed peers ([::1]:8080)
 * normalize to ::1. With no chain and no peer the result is an
 * explicit undefined - never a fabricated address.
 *
 * Measured in the WDN Step-0 lab (wdn-lab/wdn10.cjs) on frozen
 * fixtures: trustProxy 1 and 2 exact on the chain 1.2.3.4, 5.6.7.8
 * with peer 9.9.9.9 (5.6.7.8 and 1.2.3.4); malformed-left in number
 * mode never consulted (5.6.7.8); the CIDR walk meeting a malformed
 * entry stops at the peer (9.9.9.9); mapped collapse in both
 * positions; leading-zero rejected to the peer; cloudflare mode exact;
 * no-peer returns undefined.
 *
 * Integration boundary (binding): this utility does NOT replace the
 * existing default resolution path anywhere in the SDK. Client-IP
 * resolution is core identity plumbing for every module, so adoption
 * is per-surface and opt-in: a host that wants right-counted trust
 * calls resolveClientIp itself and feeds the result in (for example
 * as a quota identity ip). Nothing changes for hosts that do not.
 *
 * Pure computation: no I/O, no state, no runtime dependencies.
 */

export type TrustProxyOption = false | number | "cloudflare" | "railway" | readonly string[];

export type ClientIpHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function ipv4ToBytes(ip: string): Uint8Array | null {
  const m = IPV4_RE.exec(ip);
  if (!m) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const part = m[i + 1]!;
    if (part.length > 1 && part[0] === "0") return null; // leading zeros rejected
    const n = Number(part);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function ipv6ToBytes(input: string): Uint8Array | null {
  let s = input.toLowerCase();
  const lastColon = s.lastIndexOf(":");
  if (lastColon !== -1 && s.slice(lastColon + 1).includes(".")) {
    const tail = ipv4ToBytes(s.slice(lastColon + 1));
    if (!tail) return null;
    const g1 = ((tail[0]! << 8) | tail[1]!).toString(16);
    const g2 = ((tail[2]! << 8) | tail[3]!).toString(16);
    s = `${s.slice(0, lastColon + 1)}${g1}:${g2}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  if (head === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const tail = parseGroups(halves[1]!);
    if (tail === null) return null;
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    bytes[i * 2] = groups[i]! >> 8;
    bytes[i * 2 + 1] = groups[i]! & 0xff;
  }
  return bytes;
}

function ipToBytes(ip: string): Uint8Array | null {
  return ipv4ToBytes(ip) ?? ipv6ToBytes(ip);
}

/**
 * Normalize one raw address: strip brackets/port and any zone id,
 * collapse IPv4-mapped IPv6 to IPv4, lowercase IPv6. Returns null for
 * anything that is not a valid address (including leading-zero IPv4).
 */
export function normalizeClientIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim();
  if (!v) return null;
  if (v.startsWith("[")) {
    const close = v.indexOf("]");
    if (close === -1) return null;
    v = v.slice(1, close);
  } else if (v.includes(".") && v.split(":").length === 2) {
    v = v.slice(0, v.indexOf(":"));
  }
  const pct = v.indexOf("%");
  if (pct !== -1) v = v.slice(0, pct);
  if (ipv4ToBytes(v)) return v;
  const bytes = ipv6ToBytes(v);
  if (!bytes) return null;
  const mapped = bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) return `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  return v.toLowerCase();
}

/** True when `ip` falls inside `cidr` (or equals it when no prefix is given). Malformed input is false. */
export function clientIpInCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  const network = normalizeClientIp(slash === -1 ? cidr : cidr.slice(0, slash));
  const address = normalizeClientIp(ip);
  if (!network || !address) return false;
  const netBytes = ipToBytes(network);
  const addrBytes = ipToBytes(address);
  if (!netBytes || !addrBytes || netBytes.length !== addrBytes.length) return false;
  const totalBits = netBytes.length * 8;
  let bits = totalBits;
  if (slash !== -1) {
    const rawBits = cidr.slice(slash + 1);
    bits = Number(rawBits);
    if (rawBits === "" || !Number.isInteger(bits) || bits < 0 || bits > totalBits) return false;
  }
  const wholeBytes = bits >> 3;
  for (let i = 0; i < wholeBytes; i++) if (netBytes[i] !== addrBytes[i]) return false;
  const remainder = bits & 7;
  if (remainder) {
    const mask = (0xff << (8 - remainder)) & 0xff;
    if ((netBytes[wholeBytes]! & mask) !== (addrBytes[wholeBytes]! & mask)) return false;
  }
  return true;
}

function readClientIpHeader(headers: ClientIpHeaders, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(n: string): string | null }).get(name);
    return value ?? undefined;
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const wanted = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) {
      const value = record[key];
      return Array.isArray(value) ? value.join(",") : value;
    }
  }
  return undefined;
}

/** The forwarded chain as normalized entries; malformed entries are kept as null so walkers can stop on them. */
export function forwardedChain(headers: ClientIpHeaders): Array<string | null> {
  const raw = readClientIpHeader(headers, "x-forwarded-for");
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => normalizeClientIp(part));
}

export interface ResolveClientIpOptions {
  headers: ClientIpHeaders;
  /** The connection peer address (socket remote address), if any. */
  peer?: string;
  trustProxy?: TrustProxyOption;
}

/**
 * Resolve the client IP under a trustProxy policy. See the module
 * header for the exact mode semantics. Returns undefined only when
 * there is no evidence at all (no usable chain entry and no peer).
 */
export function resolveClientIp(options: ResolveClientIpOptions): string | undefined {
  const { headers } = options;
  const trustProxy: TrustProxyOption = options.trustProxy ?? false;
  const peer = normalizeClientIp(options.peer) ?? undefined;
  if (trustProxy === false || trustProxy === 0) return peer;
  if (trustProxy === "cloudflare") {
    return normalizeClientIp(readClientIpHeader(headers, "cf-connecting-ip")) ?? peer;
  }
  if (trustProxy === "railway") {
    return resolveClientIp({ headers, peer: options.peer, trustProxy: 2 });
  }
  const chain = forwardedChain(headers);
  const singleHeaderFallback = (): string | undefined =>
    normalizeClientIp(readClientIpHeader(headers, "x-real-ip")) ??
    normalizeClientIp(readClientIpHeader(headers, "x-vercel-forwarded-for")?.split(",").pop()) ??
    undefined;
  if (typeof trustProxy === "number") {
    if (!Number.isInteger(trustProxy) || trustProxy < 0) return peer;
    const index = chain.length - trustProxy;
    if (index < 0 || index >= chain.length) return singleHeaderFallback() ?? peer;
    return chain[index] ?? singleHeaderFallback() ?? peer;
  }
  const ranges = trustProxy as readonly string[];
  const full: Array<string | null> = peer ? [...chain, peer] : [...chain];
  for (let i = full.length - 1; i >= 0; i--) {
    const candidate = full[i]!;
    if (candidate === null) return peer; // malformed entry: stop the walk, believe nothing left of it
    if (!ranges.some((range) => clientIpInCidr(candidate, range))) return candidate;
  }
  return (full[0] ?? undefined) ?? singleHeaderFallback() ?? peer;
}
