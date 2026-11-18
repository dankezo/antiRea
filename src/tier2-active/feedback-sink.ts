/**
 * Feedback sink (NHS-17, antiRea 3.1.0).
 *
 * WHAT IT IS. An isolated, opt-in exporter utility: the host reports
 * block decisions to it, and drain() writes the exportable ones as
 * JSON decision lines to a file, atomically (write to a temp file,
 * then rename over the target), in the CrowdSec import shape:
 *   {"value":"<ip>","scope":"Ip","duration":"<ttl>s",
 *    "scenario":"<scenario>","origin":"sentinel"}
 *
 * THE BAN-LOOP GUARD (the point of the module, frozen in the NHS
 * Step-0 lab, nhs-lab/nhs17.cjs, RESULTS-NHS-STEP0.md; mechanism
 * source sentinel_cssink.c): a block is exported ONLY when it is
 * local-originated AND enforce-mode. Feed-originated blocks,
 * pulled (synced from another box) blocks and shadow-mode blocks
 * are never exported - exporting an imported ban would feed it back
 * to the feed it came from and loop it. The guard is structural:
 * onBlock() refuses those events at the door, they never enter the
 * queue.
 *
 * LAB EVIDENCE (Step-0, synthetic events; interop with real CrowdSec
 * NOT measured). Exactly the 3 local enforce-mode blocks exported,
 * in order; the feed-originated, redis-pulled and shadow blocks all
 * absent; every line parses with value/scope/duration/scenario/
 * origin complete; the pre-drain file content is untouched until the
 * atomic rename lands.
 *
 * Node builtins only (node:fs); zero runtime dependencies.
 */

/* Minimal structural view of node:fs (mirroring the crypto pattern). */
interface NodeFsLike {
  writeFileSync(path: string, data: string, encoding: string): void;
  renameSync(from: string, to: string): void;
}
declare const require: ((id: string) => NodeFsLike) | undefined;
function getNodeFs(): NodeFsLike {
  if (typeof require === "function") {
    try {
      const fs = require("node:fs");
      if (fs && typeof fs.writeFileSync === "function" && typeof fs.renameSync === "function") return fs;
    } catch {
      /* fall through to the explicit error */
    }
  }
  throw new Error("node:fs is not available in this runtime; the feedback sink requires Node.js");
}

export type FeedbackBlockOrigin = "local" | "feed" | "pulled";
export type FeedbackBlockMode = "enforce" | "shadow";

export interface FeedbackBlockEvent {
  ip: string;
  origin: FeedbackBlockOrigin;
  mode: FeedbackBlockMode;
}

export interface FeedbackSinkOptions {
  /** Target file path for the drained JSONL export. */
  filePath: string;
  /** Temp path used for the atomic write; default filePath + ".tmp". */
  tmpPath?: string;
  /** Scenario string written on every line. Default "sentinel/http-abuse" (the lab value). */
  scenario?: string;
  /** Ban duration in seconds written as "<ttl>s". Default 3600 (the lab value). */
  ttlSec?: number;
}

/** Format one export line exactly as the lab's sink wrote it. */
export function formatFeedbackDecision(ip: string, scenario: string, ttlSec: number): string {
  return JSON.stringify({ value: ip, scope: "Ip", duration: `${ttlSec}s`, scenario, origin: "sentinel" });
}

/**
 * Create a feedback sink. Opt-in and isolated: it only ever writes
 * the one configured file, only when the host calls drain().
 */
export function createFeedbackSink(options: FeedbackSinkOptions): {
  /** Report a block decision. Returns true iff it was queued (local + enforce only). */
  onBlock(event: FeedbackBlockEvent): boolean;
  /** Queued, not yet drained IPs, in order. */
  pending(): readonly string[];
  /** Atomically rewrite the sink file with the queued decisions; returns lines written. */
  drain(): number;
} {
  if (typeof options?.filePath !== "string" || options.filePath.length === 0) {
    throw new TypeError("feedback sink: filePath is required");
  }
  const filePath = options.filePath;
  const tmpPath = options.tmpPath ?? filePath + ".tmp";
  const scenario = options.scenario ?? "sentinel/http-abuse";
  const ttlSec = options.ttlSec ?? 3600;
  const queue: string[] = [];

  return {
    onBlock(event: FeedbackBlockEvent): boolean {
      // Ban-loop guard: only local-originated, enforce-mode blocks export.
      if (event && event.mode === "enforce" && event.origin === "local" && typeof event.ip === "string" && event.ip.length > 0) {
        queue.push(event.ip);
        return true;
      }
      return false;
    },
    pending: () => [...queue],
    drain(): number {
      const fs = getNodeFs();
      const content = queue.length > 0 ? queue.map((ip) => formatFeedbackDecision(ip, scenario, ttlSec)).join("\n") + "\n" : "";
      fs.writeFileSync(tmpPath, content, "utf8");
      fs.renameSync(tmpPath, filePath);
      const written = queue.length;
      queue.length = 0;
      return written;
    },
  };
}
