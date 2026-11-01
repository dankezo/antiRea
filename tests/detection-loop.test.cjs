const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

const mockReq = (path, headers = {}, fields = {}) => ({
  url: path.startsWith('http') ? path : `https://example.test${path}`,
  method: 'GET',
  headers: { get: k => headers[k.toLowerCase()] ?? null },
  ...fields,
});

const mockRes = () => ({
  headers: {},
  statusCode: undefined,
  body: undefined,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end(body) { if (body !== undefined) this.body = body; },
});

test('full loop: decoy probe taints the identity and its extraction is capped at the reduced budget', async () => {
  const AGENT_KEY = 'account:agent-1';
  const HUMAN_KEY = 'account:human-1';

  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 100 });
  const taints = [];
  const scorer = sdk.createFlowScorer({
    onTaint: event => {
      taints.push(event);
      budget.setOverride(event.sessionKey, 10); // host wiring: taint tightens the budget
    },
  });
  const mirage = sdk.createDecoyMirage({
    onHit: () => { scorer.observe(AGENT_KEY, { routeClass: 'decoy', status: 200 }); },
  });

  // Before any signal, the agent's identity has the full budget.
  assert.equal(budget.usage(AGENT_KEY).limit, 100);

  // 1. The agent probes an unused route and gets a plausible document.
  const probe = await mirage.handle(mockReq('/api/v1/internal/schema-export'));
  assert.equal(probe.isDecoy, true);
  assert.equal(probe.status, 200);

  // 2. The hit flowed through the scorer and fired the taint.
  assert.equal(taints.length, 1);
  assert.equal(taints[0].trigger, 'decoy_contact');
  assert.equal(taints[0].sessionKey, AGENT_KEY);

  // 3. The same identity's extraction is now capped at the reduced budget.
  assert.equal(budget.usage(AGENT_KEY).limit, 10);
  const page = budget.consume(AGENT_KEY, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10']);
  assert.equal(page.exceeded, false);
  assert.equal(budget.check(AGENT_KEY, 1).allowed, false); // 11th distinct record: refused

  // 4. A polite human on another identity is completely unaffected.
  assert.equal(budget.usage(HUMAN_KEY).limit, 100);
  budget.consume(HUMAN_KEY, Array.from({ length: 30 }, (_, i) => `h${i}`));
  assert.equal(budget.check(HUMAN_KEY, 1).allowed, true);
  assert.equal(scorer.score(HUMAN_KEY), 0);
});

test('polite-human zero-friction gate: every module combined stays invisible at human usage levels', async () => {
  const budget = sdk.createRecordBudget({ maxDistinctPerWindow: 2_000 });
  const scoreEvents = [];
  const scorer = sdk.createFlowScorer({ onScore: e => scoreEvents.push(e) });
  const budgetMiddleware = sdk.createExpressRecordBudgetMiddleware({
    budget,
    resolveIdentity: () => ({ accountId: 'human-1' }),
    extractRecordIds: body => (body.items ?? []).map(item => item.id),
  });
  const exportGuard = sdk.createExportGuard({
    maxRowsPerExport: 25,
    requireFilterParams: ['region'],
    recordBudget: budget,
    resolveIdentity: () => ({ accountId: 'human-1' }),
    estimateRows: () => 12,
  });
  const HUMAN = 'account:human-1';

  // Browsing: five small pages and a few details through the budget middleware.
  for (let page = 0; page < 5; page++) {
    const res = mockRes();
    let ran = false;
    await budgetMiddleware(mockReq(`/api/accounts?page=${page + 1}`), res, () => {
      ran = true;
      res.status(200).json({ items: [{ id: `p${page}-a` }, { id: `p${page}-b` }] });
    });
    assert.equal(ran, true, `page ${page + 1} must run`);
    assert.equal(res.statusCode, 200);
    scorer.observe(HUMAN, { routeClass: 'list', status: 200, pageSizeRequested: 20, recordsReturned: 2 });
    scorer.observe(HUMAN, { routeClass: 'detail', status: 200 });
  }

  // A filtered report export, well under the row cap.
  const exportResult = await exportGuard.checkRequest(mockReq('/api/reports/export?region=eu'));
  assert.equal(exportResult.allowed, true);

  // Cursor-chained pagination followed honestly, step by step.
  const secret = 'gate-secret';
  let position = 0;
  for (let step = 0; step < 3; step++) {
    const token = sdk.mintCursor(secret, { sessionId: 'human-session', position });
    const verified = sdk.verifyCursor(secret, token, {
      sessionId: 'human-session',
      expectedPosition: position,
    });
    assert.equal(verified.ok, true, `cursor step ${step} must verify`);
    position += 20;
  }

  // Nothing scored, nothing rejected, budget barely touched.
  assert.equal(scoreEvents.length, 0);
  assert.equal(scorer.score(HUMAN), 0);
  assert.ok(budget.usage(HUMAN).used <= 10 + 24, 'human usage stays trivially small');
  assert.equal(budget.check(HUMAN, 1).allowed, true);
});
