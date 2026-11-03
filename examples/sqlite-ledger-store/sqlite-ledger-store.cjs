'use strict';
/**
 * Reference transactional LedgerStoreAdapter over node:sqlite.
 *
 * Implements the `LedgerStoreAdapter` contract from
 * src/tier2-active/disclosure-ledger.ts with REAL compare-and-swap:
 *
 *   transactLedger(ledgerId, expectedVersion, updater):
 *     BEGIN IMMEDIATE                      -- take the DB write lock up front
 *     SELECT the stored ledger state       -- inside the transaction
 *     if stored.version !== expectedVersion
 *        -> ROLLBACK, { committed:false, conflict:true, version: stored }
 *     next = updater(clone(stored) | null) -- null state = no ledger yet (v0)
 *     if next === null
 *        -> ROLLBACK, { committed:false, conflict:false, version: stored }
 *     next.version = stored.version + 1    -- the STORE bumps, not the updater
 *     INSERT OR REPLACE the state; COMMIT
 *        -> { committed:true, conflict:false, version: next.version }
 *
 * Because the version check and the write happen inside one
 * BEGIN IMMEDIATE transaction, two processes (or two connections) sharing
 * one sqlite file cannot both pass the check against the same version:
 * the second writer either waits (busy timeout) and then sees the bumped
 * version - a conflict the ledger retries - or is refused by the lock.
 * That is exactly the CAS the disclosure ledger's enforce mode requires.
 *
 * Storage layout: one table `antirea_kv(key TEXT PRIMARY KEY, value TEXT)`.
 * The ledger state JSON lives under the same key the SDK itself uses,
 * `antirea:ledger:<ledgerId>` (the storeKey() helper in
 * disclosure-ledger.ts), so the adapter's get()/put() and transactLedger()
 * observe one single source of truth: readState() in the SDK reads via
 * get(), transactLedger() writes the same row. Generic (non-ledger) keys
 * a host puts through get/put land in the same table untouched.
 *
 * node:sqlite is a Node.js BUILTIN (no dependency added anywhere), but it
 * exists only on Node >= 22.5 while the SDK supports Node >= 20 - which
 * is why this adapter ships as a reference example, not as core code.
 * See README.md in this folder.
 */

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  throw new Error(
    'SQLITE_UNAVAILABLE: node:sqlite could not be loaded. ' +
      'This reference adapter requires Node.js >= 22.5 (the SDK itself supports >= 20; ' +
      'on older Node, supply your own transactional LedgerStoreAdapter).',
  );
}

// Must match storeKey() in src/tier2-active/disclosure-ledger.ts.
const storeKey = (ledgerId) => `antirea:ledger:${ledgerId}`;

function clone(value) {
  return value === null || value === undefined ? (value ?? null) : JSON.parse(JSON.stringify(value));
}

/** Synchronous sleep (main-thread Atomics.wait is available in Node). */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isBusyError(err) {
  const msg = String((err && err.message) || err);
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(msg);
}

/**
 * @param {{ filename?: string, busyTimeoutMs?: number }} [options]
 *   filename: sqlite file path. ':memory:' (default) is a private
 *   single-connection database - fine for tests and single-process use.
 *   Cross-process enforcement REQUIRES a shared file path.
 *   busyTimeoutMs: how long SQLite waits on a locked database before
 *   raising SQLITE_BUSY (default 10_000). transactLedger additionally
 *   retries busy BEGIN IMMEDIATEs until this budget is exhausted.
 */
function createSqliteLedgerStore(options = {}) {
  const filename = options.filename ?? ':memory:';
  const busyTimeoutMs = Math.max(0, Math.floor(options.busyTimeoutMs ?? 10_000));
  const db = new DatabaseSync(filename, { timeout: busyTimeoutMs });
  // WAL: readers never block the one writer and vice versa; the write
  // lock itself is what serializes CAS transactions across processes.
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec('CREATE TABLE IF NOT EXISTS antirea_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);');

  const selectStmt = db.prepare('SELECT value FROM antirea_kv WHERE key = ?');
  const upsertStmt = db.prepare('INSERT OR REPLACE INTO antirea_kv (key, value) VALUES (?, ?)');

  function get(key) {
    const row = selectStmt.get(key);
    return row ? row.value : null;
  }

  function put(key, value) {
    upsertStmt.run(key, String(value));
  }

  function transactLedger(ledgerId, expectedVersion, updater) {
    const key = storeKey(ledgerId);
    const deadline = Date.now() + busyTimeoutMs;
    let backoffMs = 2;
    for (;;) {
      let inTransaction = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        inTransaction = true;

        const row = selectStmt.get(key);
        const current = row ? JSON.parse(row.value) : null;
        const currentVersion = current ? current.version : 0;

        if (currentVersion !== expectedVersion) {
          db.exec('ROLLBACK');
          inTransaction = false;
          return Promise.resolve({ committed: false, conflict: true, version: currentVersion });
        }

        const next = updater(clone(current));
        if (next === null) {
          // Updater abort: no write, NO version bump (contract).
          db.exec('ROLLBACK');
          inTransaction = false;
          return Promise.resolve({ committed: false, conflict: false, version: currentVersion });
        }

        next.version = currentVersion + 1;
        upsertStmt.run(key, JSON.stringify(next));
        db.exec('COMMIT');
        inTransaction = false;
        return Promise.resolve({ committed: true, conflict: false, version: next.version });
      } catch (err) {
        if (inTransaction) {
          try {
            db.exec('ROLLBACK');
          } catch {
            /* connection may already be out of the transaction */
          }
        }
        // A cross-process writer can still surface SQLITE_BUSY at BEGIN
        // (e.g. during WAL checkpoint contention). Retrying a busy BEGIN
        // is safe - nothing has run yet - and keeps the ledger's own
        // conflict-retry budget for real version conflicts.
        if (isBusyError(err) && Date.now() < deadline) {
          sleepSync(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 50);
          continue;
        }
        return Promise.reject(err);
      }
    }
  }

  return {
    supportsTransactions: true,
    get,
    put,
    transactLedger,
    /** Not part of the contract; lets hosts/tests release the file handle. */
    close() {
      db.close();
    },
  };
}

// Conformance-kit factory convention: a module exporting createStore().
function createStore(options) {
  return createSqliteLedgerStore(options);
}

module.exports = { createSqliteLedgerStore, createStore };
