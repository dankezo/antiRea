/**
 * RSP-16: Git loop infinite chain (opt-in decoy server content).
 *
 * An endless fake git object graph: every object page lists further
 * object directories derived deterministically from the request, so
 * a walker never reaches a dead end or a 404 inside the chain.
 *
 * Measured in the RSP Step-0 lab: 200 seeded walks of depth 8 give
 * 0 dead ends and 0 404s; two BFS transcripts are byte-identical;
 * listings exact (16 object dirs, 3 subdirs per object page, 10
 * objects per subdir, one .idx/.pack pair); pack is 8,192 bytes
 * with PACK magic and version 2.
 *
 * Fidelity fixes applied in this build (both defects on record in
 * the lab): derived object names are 40 hex chars (the source
 * emitted 42, which a length-validating scanner spots instantly),
 * and a .idx request returns a real idx-form body starting with
 * the ff 74 4f 63 magic, not the PACK body.
 * Honeypot-surface only, advisory, low tier.
 */
import { rspHmacHex } from "../internal/rsp-crypto";

export const RSP_GIT_MAIN_SHA = "3d8f2a1b9c4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a";
export const RSP_GIT_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote \"origin\"]\n\turl = https://github.com/fake-org/fake-repo.git\n";

/** Derive a 40-char git object name from a seed (fixed length). */
export function rspGitObjectName(secret: string | Uint8Array, seed: string): string {
  return rspHmacHex(secret, seed).slice(0, 40);
}

export type RspGitResponse =
  | { status: 200; kind: "text"; body: string }
  | { status: 200; kind: "listing"; entries: string[] }
  | { status: 200; kind: "pack"; bytes: Uint8Array }
  | { status: 200; kind: "idx"; bytes: Uint8Array }
  | { status: 404; kind: "none" };

export function createRspGitLoop(options: { secret: string | Uint8Array }): { route(path: string): RspGitResponse } {
  const secret = options.secret;
  const name = (seed: string) => rspGitObjectName(secret, seed);

  function route(p: string): RspGitResponse {
    if (p.endsWith(".pack")) {
      const bytes = new Uint8Array(8192);
      bytes.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2], 0); // PACK + version 2
      return { status: 200, kind: "pack", bytes };
    }
    if (p.endsWith(".idx")) {
      const bytes = new Uint8Array(8192);
      bytes.set([0xff, 0x74, 0x4f, 0x63, 0, 0, 0, 2], 0); // idx magic ff 74 4f 63 + version 2
      return { status: 200, kind: "idx", bytes };
    }
    switch (p) {
      case "/.git/config": return { status: 200, kind: "text", body: RSP_GIT_CONFIG };
      case "/.git/HEAD": return { status: 200, kind: "text", body: "ref: refs/heads/main\n" };
      case "/.git/refs/heads/main": return { status: 200, kind: "text", body: RSP_GIT_MAIN_SHA + "\n" };
      case "/.git/description": return { status: 200, kind: "text", body: "Unnamed repository\n" };
      case "/.git/COMMIT_EDITMSG": return { status: 200, kind: "text", body: "Initial commit\n" };
      case "/.git/":
      case "/.git": return { status: 200, kind: "listing", entries: ["HEAD", "config", "description", "logs/", "objects/", "refs/"] };
      case "/.git/refs/":
      case "/.git/refs/heads/": return { status: 200, kind: "listing", entries: ["main"] };
      case "/.git/logs/": return { status: 200, kind: "listing", entries: ["HEAD", "refs/"] };
      case "/.git/objects/": {
        const entries: string[] = [];
        for (let i = 0; i < 16; i++) entries.push(i.toString(16).padStart(2, "0") + "/");
        return { status: 200, kind: "listing", entries };
      }
      case "/.git/objects/pack/": {
        const s = name("pack-1");
        return { status: 200, kind: "listing", entries: [`pack-${s}.idx`, `pack-${s}.pack`] };
      }
    }
    if (p.startsWith("/.git/objects/") && p.endsWith("/")) {
      const parent = p.slice("/.git/objects/".length);
      const entries: string[] = [];
      for (let i = 0; i < 10; i++) entries.push(name(`${parent}-${i}`));
      return { status: 200, kind: "listing", entries };
    }
    if (p.startsWith("/.git/objects/")) {
      const sha = p.split("/").pop() ?? "";
      const entries = [1, 2, 3].map((k) => name(`${sha}-${k}`).slice(0, 2) + "/");
      return { status: 200, kind: "listing", entries };
    }
    return { status: 404, kind: "none" };
  }
  return { route };
}
