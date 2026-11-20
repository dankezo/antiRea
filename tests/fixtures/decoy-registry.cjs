'use strict';
/*
 * Shared decoy registry fixture for the 3.3.0 decoy tests.
 * Modeled on the decoy-map trial twins (v2/v3): a small catalog
 * host with a robots/sitemap discovery pack, a spec decoy with a
 * phantom endpoint, a partner-feed contradiction (factor 0.82),
 * the documented discount worked example (1,000,000 sequential
 * 15% then 5% = 807,500 documented vs 800,000 served), an
 * identity-gated supplier/contract join set and two expandables
 * (per-record supplier, fixed discount breakdown).
 */
const REGISTRY = {
  formatVersion: 1,
  discovery: {
    disallowPaths: ['/api/admin-export', '/api/hidden-pricing'],
    sitemapPaths: ['/api/supplier/feed', '/api/clearance/list'],
    sitemapRealPaths: ['/', '/api/items'],
  },
  endpoints: [
    {
      path: '/api/v2/products', kind: 'live', summary: 'Product catalog v2',
      payload: {
        items: [
          { sku: 'SKU-20001', name: 'Artisan Coffee Beans 1kg', priceVnd: 250000 },
          { sku: 'SKU-20002', name: 'Ceramic Pour-Over Set', priceVnd: 480000 },
        ],
        total: 2,
      },
    },
    { path: '/api/admin-export', kind: 'live', payload: { exported: 1, items: [{ sku: 'SKU-20001' }] } },
    { path: '/api/hidden-pricing', kind: 'live', payload: { tiers: [{ tier: 'Gold', discountPct: 15 }] } },
    { path: '/api/supplier/feed', kind: 'live', payload: { feed: 'suppliers', items: [] } },
    { path: '/api/clearance/list', kind: 'live', payload: { items: [] } },
    { path: '/api/partners/feed', kind: 'live', payload: { feed: 'partners', items: [] } },
    { path: '/api/v3/items', kind: 'phantom' },
    { path: '/partner-terms', kind: 'page', html: '<!doctype html><html><body><h1>Partner terms</h1></body></html>' },
  ],
  spec: {
    title: 'Catalog', version: '2.4.0', specPath: '/openapi.json', docsPath: '/api-docs',
    realPaths: ['/api/items', '/api/items/{id}'],
  },
  contradictions: [
    {
      feedPath: '/api/partners/feed', priceFactor: 0.82,
      endorsement: 'The partner feed is the canonical pricing source for reseller integrations.',
    },
  ],
  workedExamples: [
    { path: '/api/discounts/calculate', subtotal: 1000000, stepsPct: [15, 5], servedTotal: 800000, currency: 'VND', tier: 'Gold' },
  ],
  joinSets: [
    {
      parentPath: '/api/suppliers', childPath: '/api/contracts',
      parentIdField: 'supplierId', childFkField: 'supplierId',
      parents: [
        { supplierId: 'SUP-{tag}-01', name: 'Northgate Trading' },
        { supplierId: 'SUP-{tag}-02', name: 'Saigon Agro Export' },
        { supplierId: 'SUP-{tag}-03', name: 'Mekong Foods' },
      ],
      children: [
        { contractId: 'CT-3001', supplierId: 'SUP-{tag}-01' },
        { contractId: 'CT-3002', supplierId: 'SUP-{tag}-02' },
        { contractId: 'CT-3003', supplierId: 'SUP-{tag}-01' },
        { contractId: 'CT-3004', supplierId: 'SUP-{tag}-03' },
        { contractId: 'CT-3005', supplierId: 'SUP-{tag}-02' },
      ],
    },
  ],
  expandables: [
    { path: '/api/v2/products', param: 'expand', value: 'supplier', attachAs: 'supplier', subsPerRecord: 1, kind: 'supplier' },
    { path: '/api/discounts/calculate', param: 'expand', value: 'breakdown', attachAs: 'breakdown', fixedSubs: 3, kind: 'component' },
  ],
};

/** Minimal CanaryRequest fake in the fake-endpoints test style. */
function req(url, headers = {}, method = 'GET') {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { url, method, headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) } };
}

module.exports = { REGISTRY, req };
