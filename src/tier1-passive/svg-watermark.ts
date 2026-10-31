/** Fragile markers for provenance comparisons, NOT mathematical proof of copying. */
const SEP = "\u200d", ZERO = "\u200b", ONE = "\u200c";
/** UTF-8 supports all Unicode strings (the original charCodeAt implementation did not). */
export function encodeZeroWidthSignature(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bits = Array.from(bytes, b => b.toString(2).padStart(8, "0")).join("");
  return SEP + bits.replace(/0/g, ZERO).replace(/1/g, ONE) + SEP;
}
export function decodeZeroWidthSignature(value: string): string | null {
  const start = value.indexOf(SEP);
  const end = value.indexOf(SEP, start + 1);
  if (start < 0 || end < 0) return null;
  const symbols = value.slice(start + 1, end);
  if (!symbols || symbols.length % 8 !== 0 || !Array.from(symbols).every(c => c === ZERO || c === ONE)) return null;
  const bytes = new Uint8Array(symbols.length / 8);
  for (let i = 0; i < bytes.length; i++) {
    let bits = "";
    for (let j = 0; j < 8; j++) bits += symbols[i * 8 + j] === ONE ? "1" : "0";
    bytes[i] = parseInt(bits, 2);
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return null; }
}
/** Append a moveto-only subpath. May be stripped by SVG optimizers. */
export function signSvgPath(pathD: string, numericFingerprint = 1337): string {
  if (!Number.isInteger(numericFingerprint) || numericFingerprint < 0 || numericFingerprint > 0xffffffff)
    throw new RangeError("fingerprint must be uint32");
  const h = Math.floor(numericFingerprint / 65536);
  const l = numericFingerprint % 65536;
  return `${pathD.trim()} M ${(h / 1e6).toFixed(6)} ${(l / 1e6).toFixed(6)}`;
}
export function readSvgPathSignature(pathD: string): number | null {
  const m = /(?:^|\s)M\s+(\d+\.\d{6})\s+(\d+\.\d{6})\s*$/.exec(pathD);
  if (!m) return null;
  const h = Math.round(Number(m[1]) * 1e6), l = Math.round(Number(m[2]) * 1e6);
  return h <= 65535 && l <= 65535 ? h * 65536 + l : null;
}
