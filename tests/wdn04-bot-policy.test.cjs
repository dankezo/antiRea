'use strict';
// WDN-04 bot policy publish-and-enforce - suite version of wdn-lab/wdn04.cjs.
// Frozen lab properties on deny [training_crawler], allow [perplexitybot]:
// matched set exactly 32 agents, all 9 unenforceable agents named in the
// annotation, DENY/ALLOW outcomes exact, publish and enforce reading one
// resolved set.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pol = require('../dist/tier2-active/wdn-bot-policy.js');

const GPT_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)';
const PB_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)';
const GG_UA = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BS_UA = 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)';

const policy = pol.createBotPolicy({ deny: ['training_crawler'], allow: ['perplexitybot'] });

test('POL-PUBLISH: matched set is exactly 32 agents; robots.txt carries the GPTBot group, no PerplexityBot group, and the wildcard group', () => {
  assert.equal(policy.matched.length, 32);
  const txt = policy.robotsTxt();
  assert.ok(txt.includes('User-agent: GPTBot\nDisallow: /'));
  assert.ok(!txt.includes('User-agent: PerplexityBot'));
  assert.ok(txt.includes('User-agent: *'));
});

test('POL-ANNOTATE: all 9 unenforceable matched agents are named in the annotation block', () => {
  assert.equal(policy.unenforceable.length, 9);
  assert.deepEqual(
    policy.unenforceable.map((a) => a.id).sort(),
    ['bytespider', 'chatglm-spider', 'img2dataset', 'isscyberriskcrawler', 'moonshotbot', 'omgili', 'sentibot', 'velenpublicwebcrawler', 'webzio'].sort(),
  );
  const txt = policy.robotsTxt();
  for (const a of policy.unenforceable) {
    assert.ok(txt.includes(`#   ${a.name} (${a.organization})`), a.id);
  }
  assert.ok(txt.includes('#   ByteSpider (ByteDance)'));
});

test('POL-ENFORCE: GPTBot DENY and ByteSpider DENY (the rule stops what robots.txt cannot)', () => {
  const rule = policy.rule();
  assert.equal(rule.evaluateUserAgent(GPT_UA).action, 'DENY');
  assert.equal(rule.evaluateUserAgent(BS_UA).action, 'DENY');
});

test('POL-ALLOW-WINS: PerplexityBot ALLOW; POL-OTHERS: Googlebot ALLOW', () => {
  const rule = policy.rule();
  assert.equal(rule.evaluateUserAgent(PB_UA).action, 'ALLOW');
  assert.equal(rule.evaluateUserAgent(GG_UA).action, 'ALLOW');
});
