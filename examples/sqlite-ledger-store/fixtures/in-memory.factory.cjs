'use strict';
/** Conformance-kit factory: the SDK's bundled in-memory transactional store (deliberately slow). */
const path = require('node:path');
const sdk = require(path.resolve(__dirname, '..', '..', '..', 'dist', 'index.js'));

module.exports = {
  createStore: () => sdk.createInMemoryTransactionalStore({ ioDelayMs: 5 }),
};
