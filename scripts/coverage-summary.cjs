'use strict';

// Measure dist line coverage with Node's built-in test runner and emit a
// shields.io endpoint JSON (https://shields.io/badges/endpoint-badge).
//
// Usage: node scripts/coverage-summary.cjs <output.json>
//
// The script builds first, then runs:
//   node --test --experimental-test-coverage \
//     --test-coverage-include='dist/**' tests/*.test.cjs
// and reads the "all files" line-coverage figure from the coverage report.
// The badge percentage is truncated, never rounded up, so the badge never
// overstates the measured value. Exits non-zero when the build fails, any
// test fails, no output path is given, or the report cannot be parsed.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

function fail(message) {
  console.error(`coverage-summary: ${message}`);
  process.exit(1);
}

function colorFor(percent) {
  if (percent >= 90) return 'brightgreen';
  if (percent >= 80) return 'green';
  if (percent >= 70) return 'yellow';
  if (percent >= 60) return 'orange';
  return 'red';
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  return result;
}

const outputArg = process.argv[2];
if (!outputArg) fail('usage: node scripts/coverage-summary.cjs <output.json>');

const build = run('npm', ['run', 'build']);
process.stdout.write(build.stdout || '');
process.stderr.write(build.stderr || '');
if (build.status !== 0) fail(`build failed with exit code ${build.status}`);

const testFiles = fs
  .readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.cjs'))
  .sort()
  .map((name) => path.join('tests', name));
if (testFiles.length === 0) fail('no test files found under tests/');

const suite = run(process.execPath, [
  '--test',
  '--experimental-test-coverage',
  '--test-coverage-include=dist/**',
  ...testFiles,
]);
process.stdout.write(suite.stdout || '');
process.stderr.write(suite.stderr || '');
if (suite.status !== 0) fail(`test suite failed with exit code ${suite.status}`);

const report = `${suite.stdout || ''}\n${suite.stderr || ''}`;
const match = report.match(/all files\s*\|\s*(\d+(?:\.\d+)?)/);
if (!match) fail('could not find the "all files" line in the coverage report');

const percent = Math.floor(Number.parseFloat(match[1]));
const badge = {
  schemaVersion: 1,
  label: 'coverage',
  message: `${percent}%`,
  color: colorFor(percent),
};

const outputPath = path.resolve(process.cwd(), outputArg);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(badge)}\n`);
console.log(`coverage-summary: dist line coverage ${match[1]}% -> ${outputPath}`);
console.log(JSON.stringify(badge));
