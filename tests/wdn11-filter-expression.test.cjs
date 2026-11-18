'use strict';
// WDN-11 filter expression language - suite version of wdn-lab/wdn11.cjs.
// Frozen lab properties: basic bot match fires only on the bot context,
// ip.* without enrichment is NOT_RUN (never a silent false) and fires
// once enriched, matches works, the regex cap is exact at 500/501,
// undefined comparisons are false, and a truncated expression throws
// at construction. The module is standalone - not wired into evaluate().
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fx = require('../dist/tier2-active/wdn-filter-expression.js');

const GPT_VERDICT = { known: true, id: 'gptbot', name: 'GPTBot', category: 'training_crawler', organization: 'OpenAI', score: 85, respectsRobots: true, isAI: true };
const UNKNOWN_VERDICT = { known: false, category: 'none', score: 0, isAI: false };
const baseCtx = { path: '/api/x', method: 'GET', ip: '198.51.100.10', userAgent: 'frozen', headers: {} };
const CTX_BOT = { ...baseCtx, bot: GPT_VERDICT };
const CTX_BROWSER = { ...baseCtx, bot: UNKNOWN_VERDICT };
const ENRICHMENT = {
  security: { vpn: false, proxy: false, tor: false, relay: false, hosting: false },
  location: { country: 'XX', country_name: 'Nowhere', city: 'Xtown', timezone: 'UTC' },
  network: { asn: 0, asn_org: 'Lab' },
  reputation: { abuse_score: 0, total_reports: 0, is_high_risk: false },
};
const CTX_ENRICHED = { ...CTX_BOT, enrichment: ENRICHMENT };

test('FEX-BASIC: bot.category fires on the GPTBot context and not on the browser context', () => {
  const rule = fx.createFilterRule({ expression: "bot.category == 'training_crawler'" });
  assert.equal(rule.evaluate(CTX_BOT).action, 'DENY');
  const browser = rule.evaluate(CTX_BROWSER);
  assert.equal(browser.action, 'ALLOW');
  assert.equal(browser.state, undefined);
});

test('FEX-NOTRUN: ip.country without enrichment reports NOT_RUN; FEX-ENRICHED: with enrichment it evaluates and fires', () => {
  const rule = fx.createFilterRule({ expression: "ip.country == 'XX'" });
  const notRun = rule.evaluate(CTX_BOT);
  assert.equal(notRun.state, 'NOT_RUN');
  assert.equal(notRun.action, 'ALLOW');
  assert.equal(rule.evaluate(CTX_ENRICHED).action, 'DENY');
});

test('FEX-MATCHES: req.path matches ^/api/ is true on /api/x', () => {
  assert.equal(fx.evaluateFilterExpression("req.path matches '^/api/'", CTX_BOT), true);
});

test('FEX-REGEXCAP exact at the boundary: 501 chars evaluates false, exactly 500 evaluates true', () => {
  const pat501 = '^/api/' + '.*'.repeat(247) + 'x';
  const pat500 = '^/api/' + '.*'.repeat(247);
  assert.equal(pat501.length, 501);
  assert.equal(pat500.length, 500);
  assert.equal(fx.evaluateFilterExpression(`req.path matches '${pat501}'`, CTX_BOT), false);
  assert.equal(fx.evaluateFilterExpression(`req.path matches '${pat500}'`, CTX_BOT), true);
  assert.equal(fx.MAX_FILTER_REGEX_LENGTH, 500);
});

test('FEX-UNDEF: bot.organization on an unknown-bot context is false, never a match', () => {
  const rule = fx.createFilterRule({ expression: "bot.organization == 'OpenAI'" });
  assert.equal(rule.evaluate(CTX_BROWSER).action, 'ALLOW');
});

test('FEX-PARSE: the truncated expression throws a parse Error at construction; the && spelling also throws (R-WDN-8)', () => {
  assert.throws(() => fx.createFilterRule({ expression: 'bot.category ==' }), Error);
  assert.throws(
    () => fx.createFilterRule({ expression: "bot.category == 'training_crawler' && ip.country == 'XX'" }),
    /Unexpected character '&'/,
  );
});
