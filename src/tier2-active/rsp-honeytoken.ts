/**
 * RSP-06: Planted per-IP honeytoken credentials (opt-in, default OFF).
 *
 * Honeypot-surface only, advisory, low tier. Deterministic per-(IP, path)
 * fake credentials planted in decoy content; a later presentation of a
 * planted pair attributes to the exact reading event. Derivation is
 * HMAC-SHA256 under a server secret (lab profile G2 form).
 *
 * Measured in the RSP Step-0 lab: 512 IPs give 512 distinct passwords
 * and 512 distinct AKIA ids (0 collisions); correlation 512/512 exact;
 * 0 plant writes into submitted-data columns; placeholder variants
 * (.example/.sample/.template/.dist) plant nothing.
 *
 * A plant event never carries its planted value in a submitted column:
 * plants and submissions are separate record shapes by construction.
 * This module is inert until a host constructs it; nothing here is a
 * sole blocking key.
 */
import { rspHmac } from "../internal/rsp-crypto";

const ALPHA62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface RspHoneytokenOptions {
  secret: string | Uint8Array;
}

export interface RspPlantEvent {
  kind: "plant";
  ip: string;
  path: string;
  plantedUser: string;
  plantedPass: string;
}

export interface RspHoneytokenPlants {
  plantCredential(ip: string, path: string, prefix?: string): string;
  plantAwsId(ip: string, path: string): string;
  isPlaceholderPath(path: string): boolean;
  serve(ip: string, path: string): { password: string; planted: boolean; event: RspPlantEvent | null };
  present(user: string, pass: string): { ip: string; path: string } | null;
  plantEvents(): readonly RspPlantEvent[];
}

function hmac(secret: string | Uint8Array, s: string): Uint8Array {
  return rspHmac(secret, s);
}

function derivedChars(secret: string | Uint8Array, ip: string, seed: string, alphabet: string, len: number): string {
  let out = "";
  let round = 0;
  while (out.length < len) {
    const h = hmac(secret, ip + "\n" + seed + "\n" + round);
    for (let i = 0; i < 10 && out.length < len; i++) out += alphabet[h[i]! % alphabet.length]!;
    round++;
  }
  return out;
}

export function createRspHoneytokenPlants(options: RspHoneytokenOptions): RspHoneytokenPlants {
  const secret = options.secret;
  const registry = new Map<string, { ip: string; path: string }>();
  const events: RspPlantEvent[] = [];

  function plantCredential(ip: string, path: string, prefix = "fk"): string {
    const h = hmac(secret, ip + "\n" + path);
    let out = prefix;
    for (let i = 0; i < 12; i++) out += ALPHA62[h[i]! % 62]!;
    return out;
  }
  function plantAwsId(ip: string, path: string): string {
    return "AKIA" + derivedChars(secret, ip, path, B32, 16);
  }
  function isPlaceholderPath(path: string): boolean {
    return /\.(example|sample|template|dist)$/.test(path);
  }
  function serve(ip: string, path: string) {
    if (isPlaceholderPath(path)) {
      return { password: "", planted: false, event: null };
    }
    const password = plantCredential(ip, path, "fk");
    const event: RspPlantEvent = { kind: "plant", ip, path, plantedUser: "db_user", plantedPass: password };
    events.push(event);
    registry.set("db_user\0" + password, { ip, path });
    return { password, planted: true, event };
  }
  function present(user: string, pass: string) {
    return registry.get(user + "\0" + pass) ?? null;
  }
  return { plantCredential, plantAwsId, isPlaceholderPath, serve, present, plantEvents: () => events };
}
