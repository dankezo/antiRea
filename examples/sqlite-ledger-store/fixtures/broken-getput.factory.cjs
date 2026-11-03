'use strict';
/**
 * DELIBERATELY BROKEN factory for the conformance kit demonstration.
 *
 * A plain get/put Map store that LIES: it claims
 * `supportsTransactions: true` but provides no `transactLedger`, so it
 * has no CAS primitive at all. The kit must FAIL this candidate loudly
 * with reason DISHONEST_TRANSACTION_CLAIM. Do not copy this pattern.
 */
module.exports = {
  createStore: () => {
    const data = new Map();
    return {
      supportsTransactions: true, // <-- the lie
      get: (key) => data.get(key) ?? null,
      put: (key, value) => {
        data.set(key, value);
      },
      // no transactLedger
    };
  },
};
