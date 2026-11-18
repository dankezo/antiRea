/* Shared HMAC helper for the RSP honeypot family (no @types/node in
 * this repo, mirroring the lazy-require pattern used by cursor.ts). */
interface NodeHmacLike {
  update(data: string | Uint8Array): NodeHmacLike;
  digest(): Uint8Array;
}
interface NodeCryptoLike {
  createHmac(algorithm: string, key: string | Uint8Array): NodeHmacLike;
}
declare const require: ((id: string) => NodeCryptoLike) | undefined;

export function rspHmac(secret: string | Uint8Array, data: string): Uint8Array {
  if (typeof require === "function") {
    try {
      const c = require("node:crypto");
      if (c && typeof c.createHmac === "function") return c.createHmac("sha256", secret).update(data).digest();
    } catch { /* fall through */ }
  }
  throw new Error("node:crypto is not available in this runtime; RSP modules require Node.js");
}

export function rspHmacHex(secret: string | Uint8Array, data: string): string {
  return Array.from(rspHmac(secret, data), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic seeded filler bytes (xorshift over an HMAC seed). */
export function rspSeededBytes(secret: string | Uint8Array, seed: string, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let filled = 0;
  let round = 0;
  while (filled < length) {
    const block = rspHmac(secret, seed + "\n" + round);
    for (let i = 0; i < block.length && filled < length; i++) out[filled++] = block[i] ?? 0;
    round++;
  }
  return out;
}
