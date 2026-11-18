/**
 * Multi-box ban sync (NHS-18, antiRea 3.1.0) - a host-supplied store
 * ADAPTER interface plus an in-memory reference adapter. NO Redis
 * client, NO new dependency: antiRea stays zero-dependency, and the
 * host adapts whatever shared store it already runs (Redis, SQL, a
 * KV service) to the small interface below.
 *
 * SEMANTICS (frozen in the NHS Step-0 lab, nhs-lab/nhs18.cjs,
 * RESULTS-NHS-STEP0.md; mechanism source sentinel_redis.c):
 * - a box's LOCAL ban is pushed by exactly that box, once, as
 *   SET <prefix>ban:<ip> <action> EX <ttl> - every SET carries
 *   EX > 0 (the lab fixture uses EX 3600);
 * - a tick is push-then-pull: queued local bans push first, then
 *   the box pulls every key under the prefix into its local table
 *   flagged PULLED;
 * - the pulled flag is the ban-loop guard: a pulled ban is never
 *   re-pushed (exactly 1 SET for a key, by its origin box, ever);
 * - the store being DOWN is fail-open for decisions: both boxes
 *   keep deciding locally, nothing throws, pushes stay queued, and
 *   a queued ban syncs after recovery.
 *
 * LAB EVIDENCE (Step-0, in-memory fake store; interop with a real
 * shared store is the host adapter's contract, not measured here).
 * A's ban is in the store after one tick with EX 3600; B pulls it
 * (flagged pulled) and blocks the IP; B never re-pushes it; with
 * the store down both boxes block their own new local bans and
 * nothing errors; after recovery the queued ban syncs and B blocks
 * it too.
 */

export interface BanSyncStoreEntry {
  value: string;
  expireAt: number;
  ex: number;
}

/**
 * The host-supplied shared-store adapter contract. All methods may
 * be sync or async; a method that reports failure (false / null /
 * empty scan) while the store is down is how fail-open is expressed -
 * adapters should catch their own connection errors and report
 * failure this way rather than throwing into the box.
 */
export interface BanSyncStore {
  /** SET key value EX ex at time now (seconds). Returns success. `by` names the pushing box, for write logs. */
  set(key: string, value: string, exSec: number, nowSec: number, by?: string): boolean | Promise<boolean>;
  /** All live keys under prefix at now (seconds). */
  scan(prefix: string, nowSec: number): string[] | Promise<string[]>;
  /** The live entry for a key at now (seconds), or null. */
  get(key: string, nowSec: number): BanSyncStoreEntry | null | Promise<BanSyncStoreEntry | null>;
}

export interface BanSyncWriteLogEntry {
  op: "SET";
  key: string;
  ex: number;
  by: string;
}

/**
 * The in-memory reference adapter: a faithful stand-in implementing
 * the lab's fake store, with a down switch and a write log, so
 * hosts can conformance-test their own adapter against the same
 * behaviours. Single-process only - it syncs nothing by itself.
 */
export function createInMemoryBanSyncStore(): BanSyncStore & {
  setDown(down: boolean): void;
  isDown(): boolean;
  writeLog: BanSyncWriteLogEntry[];
} {
  const kv = new Map<string, BanSyncStoreEntry>();
  const writeLog: BanSyncWriteLogEntry[] = [];
  let down = false;
  return {
    writeLog,
    setDown(d: boolean) {
      down = d;
    },
    isDown: () => down,
    set(key: string, value: string, exSec: number, nowSec: number, by?: string): boolean {
      if (down) return false;
      kv.set(key, { value, expireAt: nowSec + exSec, ex: exSec });
      writeLog.push({ op: "SET", key, ex: exSec, by: by ?? "unknown" });
      return true;
    },
    scan(prefix: string, nowSec: number): string[] {
      if (down) return [];
      return [...kv.entries()].filter(([k, v]) => k.startsWith(prefix) && v.expireAt > nowSec).map(([k]) => k);
    },
    get(key: string, nowSec: number): BanSyncStoreEntry | null {
      if (down) return null;
      const e = kv.get(key);
      return e && e.expireAt > nowSec ? e : null;
    },
  };
}

export interface BanSyncBoxOptions {
  /** This box's name (recorded as the origin of its SETs). */
  name: string;
  store: BanSyncStore;
  /** Key prefix. Default "sentinel:ban:". */
  prefix?: string;
}

export interface LocalBan {
  action: string;
  expireAt: number;
  /** True when this ban was pulled from the store (never re-pushed). */
  pulled: boolean;
}

/**
 * Create one sync box. Local decisions never depend on the store:
 * blockLocal() takes effect immediately, decide() reads only the
 * local table, and tick() is the only store contact.
 */
export function createBanSyncBox(options: BanSyncBoxOptions): {
  name: string;
  blockLocal(ip: string, action: string, ttlSec: number, nowSec: number): void;
  tick(nowSec: number): Promise<void>;
  decide(ip: string, nowSec: number): "blocked" | "allow";
  ban(ip: string): LocalBan | null;
  pendingPushes(): number;
} {
  const prefix = options.prefix ?? "sentinel:ban:";
  const store = options.store;
  const bans = new Map<string, LocalBan>();
  const queue: Array<{ ip: string; action: string; ttl: number }> = [];

  return {
    name: options.name,
    blockLocal(ip: string, action: string, ttlSec: number, nowSec: number): void {
      bans.set(ip, { action, expireAt: nowSec + ttlSec, pulled: false });
      queue.push({ ip, action, ttl: ttlSec });
    },
    async tick(nowSec: number): Promise<void> {
      const remaining: typeof queue = [];
      for (const q of queue) {
        let ok = false;
        try {
          ok = await store.set(prefix + q.ip, q.action, q.ttl, nowSec, options.name);
        } catch {
          ok = false; // store failure is fail-open: the push stays queued
        }
        if (!ok) remaining.push(q);
      }
      queue.length = 0;
      queue.push(...remaining);
      let keys: string[] = [];
      try {
        keys = await store.scan(prefix, nowSec);
      } catch {
        keys = [];
      }
      for (const k of keys) {
        const ip = k.slice(prefix.length);
        let e: BanSyncStoreEntry | null = null;
        try {
          e = await store.get(k, nowSec);
        } catch {
          e = null;
        }
        if (e && !bans.has(ip)) {
          bans.set(ip, { action: e.value, expireAt: e.expireAt, pulled: true });
        }
      }
    },
    decide(ip: string, nowSec: number): "blocked" | "allow" {
      const b = bans.get(ip);
      return b && b.expireAt > nowSec ? "blocked" : "allow";
    },
    ban: (ip: string) => bans.get(ip) ?? null,
    pendingPushes: () => queue.length,
  };
}
