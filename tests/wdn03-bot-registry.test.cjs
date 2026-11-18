'use strict';
// WDN-03 bot registry - suite version of wdn-lab/wdn03.cjs.
// Frozen lab properties: 235 entries with exact per-category counts and
// 73 respectsRobots-false entries; known bots 6/6 exact; browser FP 0/3
// on the frozen set (thin corpus); first-match order is causal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const reg = require('../dist/tier2-active/wdn-bot-registry.js');

test('REG-TABLE: 235 entries, per-category counts exact, 73 entries do not respect robots', () => {
  assert.equal(reg.BOT_REGISTRY.length, 235);
  const counts = {};
  for (const a of reg.BOT_REGISTRY) counts[a.category] = (counts[a.category] || 0) + 1;
  assert.deepEqual(counts, {
    training_crawler: 32, ai_search_crawler: 22, ai_agent: 10, search_crawler: 21,
    seo_crawler: 24, security_scanner: 17, generic_scraper: 22, headless_browser: 8,
    archiver: 5, fetcher: 24, monitoring: 13, feed_reader: 10, commercial_scraper: 13,
    ai_assistant: 14,
  });
  assert.equal(reg.BOT_REGISTRY.filter((a) => a.respectsRobots !== true).length, 73);
  assert.equal(reg.BOT_REGISTRY_CATEGORIES.length, 15);
});

test('REG-KNOWN 6/6: frozen known bots classify to the exact id and category', () => {
  const known = [
    ['gptbot', 'training_crawler', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)'],
    ['perplexitybot', 'ai_search_crawler', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)'],
    ['ahrefsbot', 'seo_crawler', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['shodan', 'security_scanner', 'Mozilla/5.0 (compatible; Shodan/1.0; +https://www.shodan.io)'],
    ['facebookexternalhit', 'fetcher', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
    ['feedly', 'feed_reader', 'FeedlyBot/1.0 (+http://www.feedly.com/fetcher.html)'],
  ];
  for (const [id, category, ua] of known) {
    const v = reg.classifyBotUserAgent(ua);
    assert.equal(v.known, true, id);
    assert.equal(v.id, id);
    assert.equal(v.category, category, id);
    assert.equal(v.enforcement, 'none');
  }
});

test('REG-BROWSER 0/3: canonical browser UAs do not classify on the frozen set', () => {
  const browsers = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15',
  ];
  for (const ua of browsers) assert.equal(reg.classifyBotUserAgent(ua).known, false, ua);
});

test('REG-FIRSTMATCH: the dual GPTBot+Googlebot UA resolves to gptbot, and swapping the entries flips it to googlebot', () => {
  const dual = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot) Googlebot/2.1 (+http://www.google.com/bot.html)';
  assert.equal(reg.classifyBotUserAgent(dual).id, 'gptbot');
  const swapped = [...reg.BOT_REGISTRY];
  const gi = swapped.findIndex((a) => a.id === 'gptbot');
  const bi = swapped.findIndex((a) => a.id === 'googlebot');
  [swapped[gi], swapped[bi]] = [swapped[bi], swapped[gi]];
  assert.equal(reg.matchBotInTable(swapped, dual).id, 'googlebot');
});

test('REG-FALSEFLAG: the ByteSpider verdict surfaces respectsRobots false', () => {
  const v = reg.classifyBotUserAgent('Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)');
  assert.equal(v.id, 'bytespider');
  assert.equal(v.respectsRobots, false);
});

test('REG-UNKNOWN: the frozen unknown UA does not classify', () => {
  assert.equal(reg.classifyBotUserAgent('ZebraReader/9.9 (InternalTool; +https://example.com/zebra)').known, false);
});
