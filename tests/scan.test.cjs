const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scanArtifactDirectory } = require('../scripts/run-audit.cjs');

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');

function withTemp(fn) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anti-rea-test-'));
  try {
    return fn(d);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
}

test('artifact scan passes when no sourcemaps are included', () => withTemp(d => {
  fs.writeFileSync(path.join(d, 'a.js'), 'console.log("safe")');
  const r = spawnSync(python, ['scripts/verify-build.py', d], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).files_with_findings, 0);

  const nodeReport = scanArtifactDirectory(d);
  assert.equal(nodeReport.hasFailures, false);
  assert.equal(nodeReport.files_with_findings, 0);
}));

test('artifact scan fails when a JS sourcemap is in public assets', () => withTemp(d => {
  fs.writeFileSync(path.join(d, 'app.js.map'), '{}');
  const r = spawnSync(python, ['scripts/verify-build.py', d], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].signal, 'public-source-map');

  const nodeReport = scanArtifactDirectory(d);
  assert.equal(nodeReport.hasFailures, true);
  assert.equal(nodeReport.findings[0].severity, 'fail');
}));

test('artifact scan fails on short-named bundle.map file', () => withTemp(d => {
  fs.writeFileSync(path.join(d, 'bundle.map'), '{"version":3}');
  const r = spawnSync(python, ['scripts/verify-build.py', d], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].severity, 'fail');

  const nodeCli = spawnSync(process.execPath, ['scripts/run-audit.cjs', d], { encoding: 'utf8' });
  assert.equal(nodeCli.status, 1);
  assert.equal(JSON.parse(nodeCli.stdout).findings[0].severity, 'fail');
}));

test('artifact scan fails on inline base64 sourceMappingURL in JS', () => withTemp(d => {
  fs.writeFileSync(
    path.join(d, 'bundle.js'),
    'console.log(1);\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n'
  );
  const r = spawnSync(python, ['scripts/verify-build.py', d], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].severity, 'fail');

  const nodeCli = spawnSync(process.execPath, ['scripts/run-audit.cjs', d], { encoding: 'utf8' });
  assert.equal(nodeCli.status, 1);
  assert.equal(JSON.parse(nodeCli.stdout).findings[0].rule, 'no-inline-sourcemap');
}));

test('artifact scan fails on inline source map inside index.html script tag', () => withTemp(d => {
  fs.writeFileSync(
    path.join(d, 'index.html'),
    '<!doctype html><html><body><script>console.log(1);\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n</script></body></html>'
  );
  const r = spawnSync(python, ['scripts/verify-build.py', d], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].severity, 'fail');

  const nodeCli = spawnSync(process.execPath, ['scripts/run-audit.cjs', d], { encoding: 'utf8' });
  assert.equal(nodeCli.status, 1);
  assert.equal(JSON.parse(nodeCli.stdout).findings[0].severity, 'fail');
}));

test('artifact scan flags external sourceMappingURL in JS for review', () => withTemp(d => {
  fs.writeFileSync(path.join(d, 'app.js'), '//# sourceMappingURL=app.js.map');
  const r = spawnSync(python, ['scripts/verify-build.py', d], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).findings[0].severity, 'review');
}));

test('artifact scan does not follow symlinks pointing to real leaked source maps', t => withTemp(scanDir => {
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antirea-ext-'));
  try {
    const realSecretMap = path.join(externalDir, 'leaked.js');
    fs.writeFileSync(
      realSecretMap,
      'console.log(1);\n//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n'
    );
    try {
      fs.symlinkSync(realSecretMap, path.join(scanDir, 'symlinked-leak.js'));
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        t.skip('no symlinks');
        return;
      }
      throw e;
    }
    const r = spawnSync(python, ['scripts/verify-build.py', scanDir], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).files_with_findings, 0);

    const nodeCli = spawnSync(process.execPath, ['scripts/run-audit.cjs', scanDir], { encoding: 'utf8' });
    assert.equal(nodeCli.status, 0);
    assert.equal(JSON.parse(nodeCli.stdout).files_with_findings, 0);
  } finally {
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
}));
