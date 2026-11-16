'use strict';
// UAS-02 UA catalogue (RESTRICTED form) - suite version of uas-lab/uas02.cjs.
// Corpora, battery and sample construction are lifted from the frozen
// Step-0 probe (REGISTRATION-UAS-STEP0.md). The shipped catalogue is the
// 107 extracted alternatives MINUS the generic set; the trap corpus is
// a regression cell asserting the restricted catalogue does NOT flag it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const uc = require('../dist/tier2-active/ua-classifier.js');

// Sample construction overrides, lifted verbatim from uas02.cjs.
const OVERRIDES = {
  'bot\\b': 'NewsBot',
  'crawl(?:ing|er)?': 'WebCrawler',
  'feed(?:fetcher|ly|parser)': 'FeedFetcher',
  'https?://': 'http://probe.example',
  '\\+http': '+http://probe.example',
  'www\\.': 'www.probe.example',
  '(?:^|\\s)[\\w.-]+@[\\w.-]+\\.[a-z]{2,}': 'admin@probe.example',
  'screaming ?frog': 'Screaming Frog',
  'got \\(': 'got (https://probe.example)',
  'internet-?measurement': 'internet-measurement',
  'yandex(?:bot|images|mobilebot)?': 'YandexBot',
};

// 36 real-browser UAs, lifted verbatim from uas02.cjs.
const BROWSER_UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Vivaldi/6.5.3206.63',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 YaBrowser/24.1.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.130 Safari/537.36 Edg/79.0.309.71',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Android 13; Mobile; rv:121.0) Gecko/121.0 Firefox/121.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 EdgA/120.0.0.0',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 OPR/76.0.0.0',
  'Mozilla/5.0 (Linux; U; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36 UCBrowser/13.4.0.1306',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 13; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1 GSA/300.0.598965302',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Brave/120',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.1; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
];

// 20-name botName battery, lifted verbatim from uas02.cjs.
const BOTNAME_BATTERY = [
  ['GPTBot/1.0', 'GPTBot'],
  ['ClaudeBot/1.0', 'ClaudeBot'],
  ['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot'],
  ['curl/8.4.0', 'curl'],
  ['Wget/1.21.4', 'Wget'],
  ['python-requests/2.31.0', 'python-requests'],
  ['sqlmap/1.7.2#stable', 'sqlmap'],
  ['Scrapy/2.11', 'Scrapy'],
  ['Go-http-client/1.1', 'Go-http-client'],
  ['HeadlessChrome/120.0', 'HeadlessChrome'],
  ['facebookexternalhit/1.1', 'facebookexternalhit'],
  ['Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)', 'bingbot'],
  ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'Googlebot'],
  ['Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)', 'AhrefsBot'],
  ['Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)', 'YandexBot'],
  ['Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)', 'SemrushBot'],
  ['Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)', 'Bytespider'],
  ['DataForSeoBot/1.0', 'DataForSeoBot'],
  ['Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)', 'GPTBot'],
  ['UptimeRobot/2.0', 'UptimeRobot'],
];

// 8 trap UAs, lifted verbatim from uas02.cjs. In the lab these flagged
// 8/8 on the FULL catalogue, each only on a generic token; the shipped
// restricted catalogue must NOT flag any of them.
const TRAPS = [
  { id: 'T1-whatsapp-webview', ua: 'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 WhatsApp/2.24.1.79' },
  { id: 'T2-pinterest-webview', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Pinterest/12.35' },
  { id: 'T3-quora-webview', ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 Quora/10.2' },
  { id: 'T4-chrome-plus-quora', ua: BROWSER_UAS[0] + ' Quora/1.0' },
  { id: 'T5-safari-plus-pinterest', ua: BROWSER_UAS[12] + ' Pinterest/12.0' },
  { id: 'T6-firefox-plus-email', ua: BROWSER_UAS[3] + ' (contact admin@example.com)' },
  { id: 'T7-chrome-plus-www', ua: BROWSER_UAS[0] + ' www.example.com' },
  { id: 'T8-webview-whatsapp', ua: 'Mozilla/5.0 (Linux; Android 12; SM-G991B; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36 WhatsApp/2.23' },
];

test('catalogue is the frozen restricted list: 107 extracted minus the 6 generic alternatives = 101', () => {
  assert.equal(uc.UA_BOT_CATALOGUE.length, 101);
  assert.ok(Object.isFrozen(uc.UA_BOT_CATALOGUE), 'catalogue must be frozen');
  assert.deepEqual([...uc.UA_CATALOGUE_EXCLUDED_GENERICS].sort(), [
    '(?:^|\\s)[\\w.-]+@[\\w.-]+\\.[a-z]{2,}',
    'bot\\b',
    'pinterest',
    'quora',
    'whatsapp',
    'www\\.',
  ].sort());
  for (const generic of uc.UA_CATALOGUE_EXCLUDED_GENERICS) {
    assert.ok(!uc.UA_BOT_CATALOGUE.includes(generic), `generic token must not ship: ${generic}`);
  }
});

test('per-alternative coverage: every shipped alternative matches its sample UA', () => {
  for (const alt of uc.UA_BOT_CATALOGUE) {
    const sample = OVERRIDES[alt] !== undefined ? OVERRIDES[alt] : alt.replace(/\\(.)/g, '$1');
    const uaSample = 'LabProbe/1.0 (compatible; ' + sample + '; X11; Linux x86_64)';
    assert.ok(new RegExp(alt, 'i').test(sample), `own regex must match its sample: ${alt}`);
    const r = uc.classifyUserAgent(uaSample);
    assert.equal(r.isBot, true, `classify must flag the sample UA for: ${alt}`);
  }
});

test('browser corpus FP cell: 0 of 36 real-browser UAs flagged', () => {
  assert.equal(BROWSER_UAS.length, 36);
  for (const ua of BROWSER_UAS) {
    const r = uc.classifyUserAgent(ua);
    assert.equal(r.isBot, false, `browser UA must not flag: ${ua}`);
    assert.equal(r.botName, null);
    assert.equal(r.matchedAlternative, null);
  }
});

test('botName battery: 20/20 names exact', () => {
  for (const [ua, expected] of BOTNAME_BATTERY) {
    const r = uc.classifyUserAgent(ua);
    assert.equal(r.isBot, true, `battery UA must be a bot: ${ua}`);
    assert.equal(r.botName, expected, `botName for: ${ua}`);
    assert.equal(uc.extractBotName(ua), expected, `extractBotName for: ${ua}`);
  }
});

test('empty-UA rule: empty and whitespace-only UA are bots named "(no user-agent)"', () => {
  for (const ua of ['', '   ', undefined, null]) {
    const r = uc.classifyUserAgent(ua);
    assert.equal(r.isBot, true);
    assert.equal(r.botName, '(no user-agent)');
    assert.equal(r.empty, true);
    assert.equal(r.matchedAlternative, null);
  }
});

test('trap regression cell: the restricted catalogue does NOT flag the 8 trap UAs', () => {
  assert.equal(TRAPS.length, 8);
  for (const t of TRAPS) {
    const r = uc.classifyUserAgent(t.ua);
    assert.equal(r.isBot, false, `trap ${t.id} must not flag under the restricted catalogue`);
    assert.equal(r.matchedAlternative, null, `trap ${t.id} matched: ${r.matchedAlternative}`);
  }
});
