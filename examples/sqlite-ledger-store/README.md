# Reference sqlite store for the disclosure ledger

`sqlite-ledger-store.cjs` is a reference `LedgerStoreAdapter` (the contract
in `src/tier2-active/disclosure-ledger.ts`) backed by a real SQL database,
with a real `transactLedger` compare-and-swap:

- one table, `antirea_kv(key TEXT PRIMARY KEY, value TEXT)`;
- the ledger state JSON lives under `antirea:ledger:<ledgerId>` - the same
  key the SDK's own `readState()` reads through `get()` - so `get`/`put`
  and `transactLedger` share one source of truth;
- `transactLedger` runs `BEGIN IMMEDIATE`, re-reads the stored version
  **inside** the transaction, returns `{ conflict: true }` without writing
  when it differs from `expectedVersion`, otherwise runs the updater,
  forces `version = stored + 1` (an updater returning `null` aborts with
  no version bump), writes and `COMMIT`s - all under the write lock, so
  the check and the write cannot be interleaved by another connection or
  another process.

## Why this lives in `examples/` and is not part of the SDK

1. **Zero runtime dependencies is a shipped guarantee of the SDK.** Core
   code (`src/`) must not depend on any database driver.
2. **`node:sqlite` is a Node.js builtin** - requiring it adds no package
   and no `node_modules` entry - **but it only exists on Node >= 22.5**,
   while the SDK's `engines` promise is Node >= 20. Moving this adapter
   into core would silently raise the SDK's floor for every user,
   including users who never touch the disclosure ledger. As an example,
   it is copy-and-adapt material for hosts on a new-enough Node.
3. Horizontally scaled hosts are expected to adapt **their own** atomic
   store (their SQL database, a Redis Lua script, ...) to the contract.
   This file is the worked example of what "real CAS" means, and
   `conformance-kit.cjs` next to it is how a host proves their adapter
   honours it.

## Usage

```js
const { createSqliteLedgerStore } = require('./sqlite-ledger-store.cjs');
const { createDisclosureLedger } = require('@dannyphan190/anti-rea');

const store = createSqliteLedgerStore({ filename: '/var/lib/myapp/ledger.db' });
const ledger = createDisclosureLedger({ store, ceilingLimit: 100 });
console.log(ledger.mode); // 'enforce'
```

For cross-process enforcement, pass a **shared file path** (WAL mode is
enabled by the adapter). `':memory:'` (the default) is a private
per-connection database and can only ever be single-process.

## Verify an adapter (yours or this one)

```sh
node conformance-kit.cjs ./fixtures/sqlite.factory.cjs     # this adapter: PASS
node conformance-kit.cjs ./fixtures/in-memory.factory.cjs  # bundled SDK store: PASS
node conformance-kit.cjs ./fixtures/broken-getput.factory.cjs # lying get/put store: FAIL
node conformance-kit.cjs /path/to/your-own-factory.cjs     # your adapter
```

A factory module exports `createStore()` returning a fresh, empty
`LedgerStoreAdapter` per call. The kit checks transact presence /
`supportsTransactions` honesty, 40-parallel-reservations-vs-ceiling-100
exactness, version-conflict + ledger retry behaviour, and that a
get/put-only store presented as transactional is rejected with a named
reason.
