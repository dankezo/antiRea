'use strict';
/** Conformance-kit factory: the reference node:sqlite store, one fresh temp file per store. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteLedgerStore } = require('../sqlite-ledger-store.cjs');

let seq = 0;
module.exports = {
  createStore: () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antirea-kit-sqlite-'));
    return createSqliteLedgerStore({ filename: path.join(dir, `ledger-${process.pid}-${seq++}.db`) });
  },
};
