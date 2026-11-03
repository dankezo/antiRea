const { test } = require('node:test');
const assert = require('node:assert/strict');
const sdk = require('../dist/index.js');

// ---------------------------------------------------------------------------
// Strict readers, written in this test against the cited formats.
// They accept exactly the documented shapes and reject everything else,
// so a round-trip through them proves the generator's output conforms.
//
// Content-Signal: Cloudflare Content Signals Policy (Sep 2025, CC0).
//   One line inside a robots.txt group:
//     Content-Signal: search=yes, ai-input=no, ai-train=no
//   Directives: search | ai-input | ai-train; values: yes | no.
// Content-Usage: IETF aipref drafts (draft-ietf-aipref-vocab +
//   draft-ietf-aipref-attach, current draft vocabulary):
//     Content-Usage: train-ai=n, ai-use=n, search=y
//   Categories: train-ai | ai-use | search; values: y | n.
// TDMRep: W3C TDM Reservation Protocol CG Final Report (2024-05-10).
//   /.well-known/tdmrep.json is a JSON ARRAY of rule objects, each with
//   "location", "tdm-reservation" (0|1) and optional "tdm-policy" (URL).
// ---------------------------------------------------------------------------

function parseDirectivePairs(line, fieldName, allowedKeys, allowedValues) {
  const prefix = `${fieldName}: `;
  assert.ok(line.startsWith(prefix), `line must start with "${prefix}": ${line}`);
  const body = line.slice(prefix.length);
  assert.ok(body.length > 0, `${fieldName} body must not be empty`);
  const out = {};
  for (const part of body.split(', ')) {
    const m = /^([a-z][a-z-]*)=([a-z]+)$/.exec(part);
    assert.ok(m, `malformed directive pair in ${fieldName}: "${part}"`);
    const [, key, value] = m;
    assert.ok(allowedKeys.includes(key), `unknown ${fieldName} directive: ${key}`);
    assert.ok(allowedValues.includes(value), `bad ${fieldName} value for ${key}: ${value}`);
    assert.ok(!(key in out), `duplicate ${fieldName} directive: ${key}`);
    out[key] = value;
  }
  return out;
}

function readRobotsGroup(lines) {
  assert.equal(lines.length, 3, 'the group is User-agent + Content-Signal + Content-Usage');
  const agent = /^User-agent: (\S+)$/.exec(lines[0]);
  assert.ok(agent, `malformed User-agent line: ${lines[0]}`);
  const contentSignal = parseDirectivePairs(
    lines[1], 'Content-Signal', ['search', 'ai-input', 'ai-train'], ['yes', 'no'],
  );
  assert.deepEqual(
    Object.keys(contentSignal).sort(), ['ai-input', 'ai-train', 'search'],
    'Content-Signal must carry exactly the three documented directives',
  );
  const contentUsage = parseDirectivePairs(
    lines[2], 'Content-Usage', ['train-ai', 'ai-use', 'search'], ['y', 'n'],
  );
  assert.deepEqual(
    Object.keys(contentUsage).sort(), ['ai-use', 'search', 'train-ai'],
    'Content-Usage must carry exactly the three aipref draft categories',
  );
  return { userAgent: agent[1], contentSignal, contentUsage };
}

const CONTACT = 'policy@example.com';
const TDM_POLICY_URL = 'https://example.com/tdm-policy.json';

function restrictive(overrides = {}) {
  return sdk.createPolicySignals({
    contact: CONTACT,
    signals: { search: true, aiInput: false, aiTrain: false },
    tdmReservation: true,
    tdmPolicyUrl: TDM_POLICY_URL,
    ...overrides,
  });
}

test('robots lines round-trip through the strict reader back to the exact host choices', () => {
  const gen = restrictive();
  const read = readRobotsGroup(gen.robotsTxtLines());
  assert.equal(read.userAgent, '*');
  assert.deepEqual(read.contentSignal, { search: 'yes', 'ai-input': 'no', 'ai-train': 'no' });
  assert.deepEqual(read.contentUsage, { 'train-ai': 'n', 'ai-use': 'n', search: 'y' });
  // Per-agent group: same signals under the named agent.
  const named = readRobotsGroup(gen.robotsTxtLines('GPTBot'));
  assert.equal(named.userAgent, 'GPTBot');
  assert.deepEqual(named.contentSignal, read.contentSignal);
  assert.deepEqual(named.contentUsage, read.contentUsage);
  // The joined block parses back line-for-line.
  assert.deepEqual(gen.robotsTxt().trimEnd().split('\n'), gen.robotsTxtLines());
});

test('tdmrepJson parses as JSON and carries the TDMRep required fields', () => {
  const gen = restrictive();
  const doc = JSON.parse(gen.tdmrepJsonString());
  assert.ok(Array.isArray(doc), 'the CG report mandates a JSON array, even for one rule');
  assert.equal(doc.length, 1);
  const [rule] = doc;
  assert.equal(rule.location, '/');
  assert.equal(rule['tdm-reservation'], 1, 'reservation matches the host choice (reserved)');
  assert.equal(rule['tdm-policy'], TDM_POLICY_URL, 'policy pointer present when a policy URL is given');
  assert.deepEqual(gen.tdmrepJson(), doc, 'object form and serialized form agree');
});

test('tdmrep without a policy URL omits the pointer; scope becomes the rule location', () => {
  const gen = sdk.createPolicySignals({
    contact: CONTACT,
    scope: '/archive/',
    signals: { search: false, aiInput: false, aiTrain: false },
    tdmReservation: true,
  });
  const [rule] = JSON.parse(gen.tdmrepJsonString());
  assert.equal(rule.location, '/archive/');
  assert.equal(rule['tdm-reservation'], 1);
  assert.ok(!('tdm-policy' in rule), 'no pointer is fabricated when the host gave no policy URL');
  assert.ok(!('tdm-policy' in gen.headers()));
});

test('opting INTO training round-trips too: ai-train=yes, train-ai=y, tdm-reservation 0', () => {
  const gen = sdk.createPolicySignals({
    contact: CONTACT,
    signals: { search: true, aiInput: true, aiTrain: true },
    tdmReservation: false,
  });
  const read = readRobotsGroup(gen.robotsTxtLines());
  assert.deepEqual(read.contentSignal, { search: 'yes', 'ai-input': 'yes', 'ai-train': 'yes' });
  assert.deepEqual(read.contentUsage, { 'train-ai': 'y', 'ai-use': 'y', search: 'y' });
  const [rule] = JSON.parse(gen.tdmrepJsonString());
  assert.equal(rule['tdm-reservation'], 0, 'reservation 0 = TDM rights not reserved');
  assert.equal(gen.headers()['tdm-reservation'], '0');
  assert.equal(gen.policyJson().signals['ai-train'], true);
});

test('tdmReservation defaults from the training choice when not passed explicitly', () => {
  const noTrain = sdk.createPolicySignals({
    contact: CONTACT, signals: { search: true, aiInput: true, aiTrain: false },
  });
  assert.equal(noTrain.tdmrepJson()[0]['tdm-reservation'], 1);
  const train = sdk.createPolicySignals({
    contact: CONTACT, signals: { search: true, aiInput: true, aiTrain: true },
  });
  assert.equal(train.tdmrepJson()[0]['tdm-reservation'], 0);
});

test('headers carry the header forms of the same declarations', () => {
  const gen = restrictive();
  const headers = gen.headers();
  assert.equal(headers['tdm-reservation'], '1');
  assert.equal(headers['tdm-policy'], TDM_POLICY_URL);
  const usage = parseDirectivePairs(
    `Content-Usage: ${headers['Content-Usage']}`, 'Content-Usage',
    ['train-ai', 'ai-use', 'search'], ['y', 'n'],
  );
  assert.deepEqual(usage, { 'train-ai': 'n', 'ai-use': 'n', search: 'y' });
});

test('policy JSON carries the contact and the same signal summary as the robots lines', () => {
  const gen = restrictive({ agentPolicy: 'https://example.com/agent-policy' });
  const policy = JSON.parse(gen.policyJsonString());
  assert.equal(policy.format, 'antirea-policy', 'the policy JSON is plainly an antiRea document');
  assert.equal(policy.contact, CONTACT);
  assert.equal(policy.scope, '/');
  assert.equal(policy.enforcement, 'none', 'the document itself states it enforces nothing');
  const read = readRobotsGroup(gen.robotsTxtLines());
  const fromRobots = {
    search: read.contentSignal.search === 'yes',
    'ai-input': read.contentSignal['ai-input'] === 'yes',
    'ai-train': read.contentSignal['ai-train'] === 'yes',
  };
  assert.deepEqual(policy.signals, fromRobots, 'policy summary and robots lines cannot drift apart');
  assert.deepEqual(policy.contentUsage, read.contentUsage);
  const [rule] = JSON.parse(gen.tdmrepJsonString());
  assert.deepEqual(policy.tdm, { 'tdm-reservation': rule['tdm-reservation'], 'tdm-policy': rule['tdm-policy'] });
  assert.equal(policy.agentPolicy, 'https://example.com/agent-policy');
  assert.deepEqual(gen.policyJson(), policy, 'object form and serialized form agree');
});

test('invalid directive values are rejected with the named PolicySignalsError', () => {
  const cases = [
    ['aiTrain as a string', { signals: { search: true, aiInput: false, aiTrain: 'maybe' } }],
    ['search as a string', { signals: { search: 'yes', aiInput: false, aiTrain: false } }],
    ['tdmReservation as a string', { tdmReservation: 'yes' }],
    ['tdmPolicyUrl not a URL', { tdmPolicyUrl: 'not a url' }],
    ['tdmPolicyUrl wrong scheme', { tdmPolicyUrl: 'ftp://example.com/p.json' }],
    ['empty contact', { contact: '  ' }],
    ['contact with a newline (robots injection)', { contact: 'a@b.c\nDisallow: /' }],
    ['scope not a path', { scope: 'archive' }],
    ['missing signals', { signals: undefined }],
  ];
  for (const [label, overrides] of cases) {
    assert.throws(
      () => restrictive(overrides),
      (err) => err instanceof sdk.PolicySignalsError && err.name === 'PolicySignalsError',
      `case must throw the named error: ${label}`,
    );
  }
  assert.throws(() => sdk.createPolicySignals(), sdk.PolicySignalsError);
  assert.throws(() => gen_bad_agent(), sdk.PolicySignalsError);
  function gen_bad_agent() {
    return restrictive().robotsTxtLines('Bad\nAgent: *');
  }
});
