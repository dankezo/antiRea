'use strict';
/**
 * Audit runner with two modes:
 *
 *   node scripts/run-audit.cjs <build-dir>   Scan a deployment artifact directory
 *                                            for source-map leaks (the Node twin of
 *                                            scripts/verify-build.py; same rules,
 *                                            same report shape, exit 1 on any fail).
 *   node scripts/run-audit.cjs               Repo self-check (scripts/audit-repo.py).
 *
 * All script paths are resolved relative to this file's own directory, never
 * the caller's cwd. When required as a module it exports
 * `scanArtifactDirectory(dir)` and runs nothing.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_FILES = 100_000;
const FULL_TEXT_LIMIT = 10 * 1024 * 1024;
const CHUNK = 1024 * 1024;

const SCANNABLE_TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.css', '.html', '.htm', '.svg',
]);

const INLINE_SOURCEMAP_RE = /[#@]\s*sourceMappingURL\s*=\s*data:application\/json(?:;charset=[^;,\s]+)?;base64,[A-Za-z0-9+/=]+/i;
const EXTERNAL_SOURCEMAP_RE = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"]+)/i;
const HEADERS_SOURCEMAP_RE = /^\s*SourceMap\s*:\s*\S+/im;

const MAP_FILENAME_SUFFIXES = ['.map', '.map.gz', '.map.br'];

const finding = (p, severity, signal, rule) => ({ path: p, severity, signal, rule });

/** Stream `file` and return the subset of byte `needles` found anywhere in it. */
function chunkedContains(file, needles, caseInsensitive) {
  const wanted = needles.map(n => (caseInsensitive ? n.toLowerCase() : n));
  const found = new Set();
  const longest = Math.max(...wanted.map(n => n.length));
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let carry = Buffer.alloc(0);
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, CHUNK, null);
      if (bytesRead === 0) break;
      const buf = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
      const haystack = caseInsensitive ? buf.toString('latin1').toLowerCase() : buf.toString('latin1');
      for (let i = 0; i < wanted.length; i++) {
        if (!found.has(needles[i]) && haystack.includes(wanted[i].toString('latin1'))) found.add(needles[i]);
      }
      carry = buf.subarray(Math.max(0, buf.length - (longest - 1)));
      if (found.size === needles.length) break;
    }
  } finally {
    fs.closeSync(fd);
  }
  return found;
}

/**
 * Chunked scan for `sourceMappingURL` markers in a file too large to load
 * whole. Mirrors `_scan_large_text` in verify-build.py: a marker counts only
 * with a `#`/`@` comment prefix just before it.
 * Returns a list containing 'inline' and/or 'external'.
 */
function scanLargeText(file) {
  const marker = 'sourcemappingurl';
  const kinds = [];
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(CHUNK);
    let carry = '';
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, CHUNK, null);
      const eof = bytesRead === 0;
      const buf = carry + buffer.subarray(0, bytesRead).toString('latin1');
      const low = buf.toLowerCase();
      let start = 0;
      for (;;) {
        const idx = low.indexOf(marker, start);
        if (idx < 0) break;
        if (!eof && idx + marker.length + 160 > buf.length) break; // tail arrives via carry
        let j = idx - 1;
        let blanks = 0;
        while (j >= 0 && (low[j] === ' ' || low[j] === '\t') && blanks < 4) { j -= 1; blanks += 1; }
        if (j < 0 || (low[j] !== '#' && low[j] !== '@')) { start = idx + marker.length; continue; }
        const tail = low.slice(idx + marker.length, idx + marker.length + 160).replace(/^[\s=]+/, '');
        const kind = tail.startsWith('data:') ? 'inline' : 'external';
        if (!kinds.includes(kind)) kinds.push(kind);
        start = idx + marker.length;
        if (kinds.length === 2) break;
      }
      if (eof || kinds.length === 2) break;
      carry = buf.slice(-4096);
    }
  } finally {
    fs.closeSync(fd);
  }
  return kinds;
}

function scanArtifactDirectory(root) {
  const findings = [];
  const base = path.resolve(String(root));
  if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
    throw new Error('Supply an existing deployment asset directory');
  }
  let count = 0;
  let capped = false;
  const stack = [base];
  while (stack.length > 0 && !capped) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue; // never follow symlinks out of the tree
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      count += 1;
      if (count > MAX_FILES) { capped = true; break; }
      const rel = path.relative(base, full).split(path.sep).join('/');
      const nameLower = entry.name.toLowerCase();
      const suffixLower = path.extname(entry.name).toLowerCase();
      const size = fs.statSync(full).size;
      if (MAP_FILENAME_SUFFIXES.some(s => nameLower.endsWith(s))) {
        findings.push(finding(rel, 'fail', 'public-source-map', 'no-sourcemap-file'));
      } else if (nameLower === '_headers') {
        let matched;
        if (size <= FULL_TEXT_LIMIT) {
          matched = HEADERS_SOURCEMAP_RE.test(fs.readFileSync(full, 'utf8'));
        } else {
          matched = chunkedContains(full, [Buffer.from('sourcemap:')], true).size > 0;
        }
        if (matched) findings.push(finding(rel, 'fail', 'sourcemap-response-header', 'no-sourcemap-header'));
      } else if (suffixLower === '.json') {
        const found = chunkedContains(full, [Buffer.from('"mappings"'), Buffer.from('"sources"')], false);
        if (found.size === 2) findings.push(finding(rel, 'fail', 'renamed-source-map', 'no-renamed-sourcemap'));
      } else if (SCANNABLE_TEXT_EXTENSIONS.has(suffixLower)) {
        if (size <= FULL_TEXT_LIMIT) {
          const text = fs.readFileSync(full, 'utf8');
          if (INLINE_SOURCEMAP_RE.test(text)) {
            findings.push(finding(rel, 'fail', 'inline-source-map', 'no-inline-sourcemap'));
          } else if (EXTERNAL_SOURCEMAP_RE.test(text)) {
            findings.push(finding(rel, 'fail', 'external-source-map', 'no-external-sourcemap-ref'));
          }
        } else {
          for (const kind of scanLargeText(full)) {
            findings.push(kind === 'inline'
              ? finding(rel, 'fail', 'inline-source-map', 'no-inline-sourcemap')
              : finding(rel, 'fail', 'external-source-map', 'no-external-sourcemap-ref'));
          }
        }
      }
    }
  }
  if (capped) findings.push(finding('.', 'fail', 'coverage-incomplete', 'scan-file-cap-exceeded'));
  return {
    directory: String(root),
    files_with_findings: findings.length,
    findings,
    hasFailures: findings.some(f => f.severity === 'fail'),
  };
}

function runSelfCheck() {
  const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(__dirname, 'audit-repo.py');
  const result = spawnSync(python, [script], { stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

if (require.main === module) {
  const target = process.argv[2];
  if (target === undefined) {
    runSelfCheck();
  } else {
    let report;
    try {
      report = scanArtifactDirectory(target);
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
    console.log(JSON.stringify({
      directory: report.directory,
      files_with_findings: report.files_with_findings,
      findings: report.findings,
    }, null, 2));
    process.exit(report.hasFailures ? 1 : 0);
  }
}

module.exports = { scanArtifactDirectory };
