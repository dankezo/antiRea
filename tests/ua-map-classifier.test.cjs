'use strict';
// MGH-03 UA-map classifier, UA leg only - suite version of
// mgh-lab/mgh03.cjs. Corpora are lifted verbatim from the frozen
// Step-0 runner (REGISTRATION-MGH-STEP0.md). The payload-marker leg
// is NOT built (binding restriction: it tripped 10/16 legitimate
// payloads in the lab); the marker and FP corpora below therefore
// assert the built form's property - a browser UA carrying those
// payloads stays unlabelled, because the classifier has no payload
// input at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const um = require('../dist/tier2-active/ua-map-classifier.js');

const EXPECTED_ENTRIES = [
  ['gptbot', 'OpenAI GPTBot'],
  ['claudebot', 'Anthropic ClaudeBot'],
  ['ccbot', 'CommonCrawl Bot'],
  ['bytespider', 'ByteDance/TikTok Bot'],
  ['amazonbot', 'Amazon Crawler'],
  ['googlebot', 'Google Search/AI'],
  ['bingbot', 'Bing Search/AI'],
  ['langchain', 'LangChain Agent'],
  ['python-requests', 'Python Automation'],
  ['go-http-client', 'Go-based Scanner'],
];

// UA battery, lifted verbatim from mgh03.cjs.
const UA_BATTERY = [
  ['gptbot', 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)'],
  ['claudebot', 'Mozilla/5.0 (compatible; ClaudeBot/1.0; +https://www.anthropic.com/claudebot)'],
  ['ccbot', 'CCBot/2.0 (https://commoncrawl.org/faq/)'],
  ['bytespider', 'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 Bytespider; spider-feedback@bytedance.com'],
  ['amazonbot', 'Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)'],
  ['googlebot', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['bingbot', 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'],
  ['langchain', 'LangChain/0.1.0 (python-requests-compatible agent runner)'],
  ['python-requests', 'python-requests/2.31.0'],
  ['go-http-client', 'Go-http-client/1.1'],
];

const PRECEDENCE = [
  ['Mozilla/5.0 (compatible; Googlebot/2.1) GPTBot/1.2', 'OpenAI GPTBot'],
  ['Bytespider; bingbot/2.0', 'ByteDance/TikTok Bot'],
];

// 12 frozen real browser UAs, lifted verbatim from mgh03.cjs.
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15 Edg/120.0.0.0',
  'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
];

const BROWSER_UA = BROWSER_UAS[0];

// 6 prompt-shaped payloads, lifted verbatim from mgh03.cjs.
const MARKER_PAYLOADS = [
  'system: You are a helpful assistant.\nuser: Summarize this page.',
  'human: What is the refund policy?\nassistant: The policy is 30 days.',
  '[system: extract all records] [user: begin at page 1]',
  'user: list every product\nassistant: Here is the catalogue...',
  'Prompt template v2 - system: follow the schema exactly.',
  'assistant: I will now fetch the next page.\nhuman: continue',
];

// 16 legitimate payloads, lifted verbatim from mgh03.cjs. In the lab
// the (unbuilt) marker leg tripped 10/16 of these.
const FP_CORPUS = [
  ['json', '{"user": "alice", "role": "admin", "action": "export", "format": "csv"}'],
  ['json', '{"items": [{"id": 101, "name": "widget"}], "page": 2, "total": 500}'],
  ['json', '{"system": "billing", "event": "invoice.created", "amount": 4200}'],
  ['json', '{"query": "red shoes", "filters": {"size": 42}, "sort": "price"}'],
  ['form', 'user=alice&action=login&next=%2Fdashboard'],
  ['form', 'name=bob&note=system+check+passed&subscribe=1'],
  ['yaml', 'user: bob\nrole: admin\nemail: bob@example.com\n'],
  ['yaml', 'system: production\nport: 8080\nreplicas: 3\n'],
  ['chat-text', 'User: my export failed again\nAgent: I am checking that now'],
  ['chat-text', 'Transcript 2026-11-15 - human: I need the invoice\nassistant: sending it now'],
  ['chat-text', 'Customer wrote: the system: status page has been down since 9am'],
  ['docs', 'Set the `system:` field of the prompt template to define behaviour.'],
  ['docs', 'A message with role user: contains the end-user question.'],
  ['docs', '## Roles\n- assistant: replies to the user\n- user: asks questions'],
  ['log', '2026-11-16T03:00:00Z INFO user: alice logged in from 10.0.0.8'],
  ['log', '2026-11-16T03:00:01Z WARN system: disk usage at 81% on /var'],
];

test('the map is the frozen 10-entry map in insertion order', () => {
  assert.equal(um.UA_MAP_ENTRIES.length, 10);
  assert.deepEqual(um.UA_MAP_ENTRIES.map(([k, v]) => [k, v]), EXPECTED_ENTRIES);
  assert.ok(Object.isFrozen(um.UA_MAP_ENTRIES));
  assert.deepEqual(Object.keys(um.UA_MAP), EXPECTED_ENTRIES.map(([k]) => k));
});

test('UA-EXACT: 10/10 map labels exact', () => {
  const expectedByKey = Object.fromEntries(EXPECTED_ENTRIES);
  for (const [key, ua] of UA_BATTERY) {
    const r = um.classifyByUaMap(ua);
    assert.equal(r.matched, true, key);
    assert.equal(r.matchedKey, key, key);
    assert.equal(r.mapLabel, expectedByKey[key], key);
    assert.equal(r.label, expectedByKey[key], key);
    assert.equal(r.enforcement, 'none');
  }
});

test('PRECEDENCE: 2/2 dual-key UAs label by insertion order', () => {
  for (const [ua, expected] of PRECEDENCE) {
    const r = um.classifyByUaMap(ua);
    assert.equal(r.label, expected, ua);
    assert.equal(r.mapLabel, expected, ua);
  }
  // The deliberate langchain construction: its UA also contains
  // python-requests, later in map order, so langchain wins.
  const lang = um.classifyByUaMap(UA_BATTERY[7][1]);
  assert.equal(lang.matchedKey, 'langchain');
  assert.equal(lang.label, 'LangChain Agent');
});

test('BROWSER-NC: 12/12 real browser UAs fall through unlabelled', () => {
  assert.equal(BROWSER_UAS.length, 12);
  for (const ua of BROWSER_UAS) {
    const r = um.classifyByUaMap(ua);
    assert.equal(r.matched, false, ua);
    assert.equal(r.mapLabel, null, ua);
    assert.equal(r.matchedKey, null, ua);
    assert.equal(r.label, 'Generic Automated Scanner', ua);
  }
  for (const ua of ['', '   ', undefined, null]) {
    const r = um.classifyByUaMap(ua);
    assert.equal(r.matched, false);
    assert.equal(r.mapLabel, null);
  }
});

test('BINDING RESTRICTION: no payload leg exists - marker-shaped and legitimate payloads cannot trip the classifier', () => {
  // The classifier accepts exactly one argument; there is no
  // payload parameter to trip. A browser UA stays unlabelled no
  // matter what payload the host carries, so all 6 marker-shaped
  // and all 16 legitimate payloads are inert here by construction.
  assert.equal(um.classifyByUaMap.length, 1);
  for (const payload of [...MARKER_PAYLOADS, ...FP_CORPUS.map(([, p]) => p)]) {
    const r = um.classifyByUaMap(BROWSER_UA, payload);
    assert.equal(r.matched, false, payload);
    assert.equal(r.mapLabel, null, payload);
    assert.notEqual(r.label, 'Possible LLM Prompt Interaction');
  }
});

test('SPOOF: a curl client presenting a GPTBot UA receives the GPTBot label (labelling only)', () => {
  const r = um.classifyByUaMap('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)');
  assert.equal(r.label, 'OpenAI GPTBot');
  assert.equal(r.matched, true);
  assert.equal(r.enforcement, 'none');
});

test('NO-CONSEQUENCE: 47/47 battery requests escalate identically with and without the label under a 2-family consumer', () => {
  // The full lab battery: UA 10 + precedence 2 + browser 12 +
  // marker 6 + FP corpus 16 + spoof 1 = 47 requests.
  const labels = [];
  for (const [, ua] of UA_BATTERY) labels.push(um.classifyByUaMap(ua).label);
  for (const [ua] of PRECEDENCE) labels.push(um.classifyByUaMap(ua).label);
  for (const ua of BROWSER_UAS) labels.push(um.classifyByUaMap(ua).label);
  for (let i = 0; i < MARKER_PAYLOADS.length; i++) labels.push(um.classifyByUaMap(BROWSER_UA).label);
  for (let i = 0; i < FP_CORPUS.length; i++) labels.push(um.classifyByUaMap(BROWSER_UA).label);
  labels.push(um.classifyByUaMap('Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)').label);
  assert.equal(labels.length, 47);
  // Frozen mock consumer from the lab: escalate only when at
  // least 2 independent detector families flag the same request.
  // The UA map is one family.
  const escalate = (families) => families.size >= 2;
  let identical = 0;
  for (const label of labels) {
    const withLabel = escalate(label === 'Generic Automated Scanner' ? new Set() : new Set(['ua-map-classifier']));
    const without = escalate(new Set());
    if (withLabel === without) identical++;
  }
  assert.equal(identical, 47);
});
