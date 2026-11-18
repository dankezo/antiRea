/**
 * AC-31 - Data-payload padding channel, L3 ONLY (PASS-LAB).
 *
 * Lab record (ac-batch1-lab, RESULTS-AC-BATCH1-STEP0.md,
 * ac31-results.json, real ZIP bytes, no seed): four candidate
 * layers were planted per channel bundle (web / store / partner).
 * After the rebuild pipeline, exactly ONE layer survives:
 *   L1 (entry order)               dies to sorted repackaging
 *   L2 (archive comment + extras)  dies to stripping
 *   L3 (padding inside data.bin)   SURVIVES: attribution 3/3
 *   L3b (trailing padding in img)  dies to the re-encode step
 * Only L3 is built here. The other layers must not be added: they
 * are measured dead, not merely unbuilt.
 *
 * SCOPE LIMIT, stated plainly as in the lab: marks survive
 * REPACKAGING, not REGENERATION. A rebuild that regenerates data
 * files from observed behaviour instead of copying bytes kills L3
 * as well. The channel variants are also not diff-quiet (the lab
 * measured 25-34 differing byte regions per pair), so an adversary
 * holding two channels' builds can see that marks exist.
 *
 * Form: the host's data payload carries a padding region (bytes
 * the payload format ignores). This module writes a small framed
 * channel tag into the START of that padding and reads it back:
 * magic "AC31", one length byte, the channel id (UTF-8, at most
 * 64 bytes), and a 16-bit FNV checksum over the id. Extraction
 * returns null on any framing or checksum failure, including a
 * regenerated payload whose padding was re-created empty.
 *
 * Forensic tier, opt-in, advisory attribution only.
 */

const MAGIC = [0x41, 0x43, 0x33, 0x31] as const; // "AC31"
const MAX_CHANNEL_BYTES = 64;

function checksum(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0xffff;
}

export interface PaddingChannelRegion {
  /** The full payload bytes. Never mutated by embed. */
  payload: Uint8Array;
  /** Offset of the padding region inside the payload. */
  paddingOffset: number;
  /** Length of the padding region. */
  paddingLength: number;
}

/**
 * Write the channel tag into a copy of the payload's padding
 * region and return the new payload. Throws RangeError when the
 * padding region cannot hold the tag or the channel id is empty
 * or over 64 UTF-8 bytes.
 */
export function embedPaddingChannel(region: PaddingChannelRegion, channelId: string): Uint8Array {
  const id = new TextEncoder().encode(channelId);
  if (id.length === 0 || id.length > MAX_CHANNEL_BYTES) {
    throw new RangeError("embedPaddingChannel: channelId must be 1-64 UTF-8 bytes");
  }
  const needed = MAGIC.length + 1 + id.length + 2;
  if (region.paddingLength < needed || region.paddingOffset < 0 || region.paddingOffset + needed > region.payload.length) {
    throw new RangeError("embedPaddingChannel: padding region too small for the channel tag");
  }
  const out = new Uint8Array(region.payload);
  let at = region.paddingOffset;
  for (const b of MAGIC) out[at++] = b;
  out[at++] = id.length;
  out.set(id, at);
  at += id.length;
  const sum = checksum(id);
  out[at++] = (sum >> 8) & 0xff;
  out[at++] = sum & 0xff;
  return out;
}

/**
 * Read the channel tag back from a payload's padding region.
 * Returns the channel id, or null when no valid tag is present
 * (stripped, corrupted, or regenerated padding).
 */
export function extractPaddingChannel(region: PaddingChannelRegion): string | null {
  const { payload, paddingOffset, paddingLength } = region;
  if (paddingOffset < 0 || paddingLength < MAGIC.length + 1 + 2 || paddingOffset + MAGIC.length + 1 > payload.length) {
    return null;
  }
  for (let i = 0; i < MAGIC.length; i++) {
    if (payload[paddingOffset + i] !== MAGIC[i]) return null;
  }
  const len = payload[paddingOffset + MAGIC.length] ?? 0;
  if (len === 0 || len > MAX_CHANNEL_BYTES) return null;
  const start = paddingOffset + MAGIC.length + 1;
  if (start + len + 2 > payload.length || start + len + 2 > paddingOffset + paddingLength) return null;
  const id = payload.slice(start, start + len);
  const stored = ((payload[start + len] ?? 0) << 8) | (payload[start + len + 1] ?? 0);
  if (checksum(id) !== stored) return null;
  return new TextDecoder().decode(id);
}
