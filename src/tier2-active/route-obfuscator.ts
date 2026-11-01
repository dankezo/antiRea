import { getClientDecoyRoutes, registerClientBundleCanaries } from "./honeypot-middleware";

/** Compatibility utility. XOR+base64 is reversible encoding, not cryptography or access control. */
export function encodeRoute(route: string, salt = 0x5a): string {
  if (!Number.isInteger(salt) || salt < 0 || salt > 255) throw new RangeError("salt must be one byte");
  const bytes = new TextEncoder().encode(route);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b ^ salt);
  return btoa(binary);
}

export function resolveRoute(route: string, salt = 0x5a): string {
  if (!Number.isInteger(salt) || salt < 0 || salt > 255) throw new RangeError("salt must be one byte");
  const raw = atob(route);
  const bytes = Uint8Array.from(raw, c => c.charCodeAt(0) ^ salt);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export { getClientDecoyRoutes, registerClientBundleCanaries };
