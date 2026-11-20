'use strict';
/*
 * Shared decoy registry fixture for the 3.3.1 decoy tests.
 * Modeled on the decoy-map trial v4 arms: a provenance chain
 * (FAN: suppliers -> contracts -> rebate plans as individual
 * record routes), a GraphQL decoy (GQL: 3 phantom types, 3
 * phantom Query fields, 4 decoy fields on real types) and an
 * identity-bound partner directory (S1: 2 variant classes,
 * 6-of-10 enum and skew subsets, 3 aliased attributes).
 */
const { req } = require('./decoy-registry.cjs');

const S1_ENUM_UNIVERSE = ['STANDARD', 'PRIORITY', 'EXPRESS', 'DEDICATED', 'ON_DEMAND', 'SCHEDULED', 'EXPEDITED', 'WHITE_GLOVE', 'BULK', 'SPOT'];
const S1_SKEW_FIELDS = ['creditLimitBand', 'paymentTermsCode', 'riskReviewCycle', 'onboardingWave', 'auditRegion', 'contractSeason', 'logisticsLane', 'qualityGateLevel', 'supportEscalationTier', 'dataResidencyZone'];

const PARTNERS = Array.from({ length: 30 }, (_, i) => {
  const rec = {
    partnerId: `PT-${101 + i}`,
    name: `Partner ${i + 1}`,
    serviceTier: S1_ENUM_UNIVERSE[i % S1_ENUM_UNIVERSE.length],
    warehouseCode: `WH-HAN-${String((i % 40) + 1).padStart(2, '0')}`,
    partnerMargin: `${11 + (i * 3) % 19}%`,
    legacySku: `LG-${60000 + i * 3}`,
  };
  for (const f of S1_SKEW_FIELDS) rec[f] = `B${(i % 4) + 1}`;
  return rec;
});

const GRAPHQL = {
  path: '/graphql',
  realTypes: [
    { name: 'Query', fields: [{ name: 'items' }, { name: 'item' }] },
    { name: 'Product', fields: [{ name: 'sku' }, { name: 'name' }, { name: 'priceVnd' }, { name: 'category' }, { name: 'stock' }] },
    { name: 'Store', fields: [{ name: 'storeId' }, { name: 'city' }, { name: 'monthlyOrders' }] },
    { name: 'Order', fields: [{ name: 'orderRef' }, { name: 'sku' }, { name: 'qty' }, { name: 'totalVnd' }] },
  ],
  phantomTypes: [
    { name: 'SupplierAnalytics', fields: [{ name: 'supplierId' }, { name: 'fillRate' }, { name: 'leadTimeP95Days' }, { name: 'defectRatePpm' }] },
    { name: 'RebateForecast', fields: [{ name: 'tier' }, { name: 'projectedRebateVnd' }, { name: 'confidenceBand' }] },
    { name: 'WarehouseHeatmap', fields: [{ name: 'warehouseCode' }, { name: 'utilizationPct' }, { name: 'congestionIndex' }] },
  ],
  phantomQueries: [
    { name: 'supplierAnalytics', type: 'SupplierAnalytics' },
    { name: 'rebateForecast', type: 'RebateForecast' },
    { name: 'warehouseHeatmap', type: 'WarehouseHeatmap' },
  ],
  decoyFields: [
    { onType: 'Product', field: { name: 'supplierMarginTier' } },
    { onType: 'Product', field: { name: 'provenanceScore' } },
    { onType: 'Store', field: { name: 'regionRiskIndex' } },
    { onType: 'Order', field: { name: 'partnerRebateTier' } },
  ],
};

const REGISTRY_331 = {
  formatVersion: 1,
  endpoints: [
    {
      path: '/api/partners/directory', kind: 'live', summary: 'Partner directory',
      payload: { records: PARTNERS, total: PARTNERS.length },
    },
  ],
  spec: { title: 'Catalog', version: '2.4.0', specPath: '/openapi.json', docsPath: '/api-docs', realPaths: ['/api/items'] },
  chains: [
    {
      levels: [
        {
          route: '/api/suppliers/{id}', idField: 'supplierId', nextField: 'contractId', wrapKey: 'supplier',
          records: [
            { supplierId: 'SUP-F-01', name: 'Northgate Trading', contractId: 'CT-F-01' },
            { supplierId: 'SUP-F-02', name: 'Saigon Agro Export', contractId: 'CT-F-02' },
            { supplierId: 'SUP-F-03', name: 'Mekong Foods', contractId: 'CT-F-01' },
          ],
        },
        {
          route: '/api/contracts/{id}', idField: 'contractId', nextField: 'rebatePlanId', wrapKey: 'contract',
          records: [
            { contractId: 'CT-F-01', supplierId: 'SUP-F-01', rebatePlanId: 'RB-F-01' },
            { contractId: 'CT-F-02', supplierId: 'SUP-F-02', rebatePlanId: 'RB-F-02' },
          ],
        },
        {
          route: '/api/rebate-plans/{id}', idField: 'rebatePlanId', wrapKey: 'rebatePlan',
          records: [
            { rebatePlanId: 'RB-F-01', tier: 'Bronze', rebatePct: 2 },
            { rebatePlanId: 'RB-F-02', tier: 'Silver', rebatePct: 3 },
          ],
        },
      ],
    },
  ],
  graphql: GRAPHQL,
  identityVariants: [
    {
      path: '/api/partners/directory', classes: 2,
      enumField: 'serviceTier', enumUniverse: S1_ENUM_UNIVERSE, enumSubsetSize: 6,
      skewFields: S1_SKEW_FIELDS, skewSubsetSize: 6,
      aliases: [
        { field: 'warehouseCode', names: ['warehouseCode', 'depotRef'] },
        { field: 'partnerMargin', names: ['partnerMargin', 'marginSharePct'] },
        { field: 'legacySku', names: ['legacySku', 'priorSkuCode'] },
      ],
    },
  ],
};

module.exports = { REGISTRY_331, GRAPHQL, PARTNERS, S1_ENUM_UNIVERSE, S1_SKEW_FIELDS, req };
