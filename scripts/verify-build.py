#!/usr/bin/env python3
"""Read-only static deployment-artifact scan. Usage: python3 scripts/verify-build.py dist-or-public-dir

Scan ONLY the exact directory that you intend to deploy publicly.
This detects common source map leaks, not actual privacy or anti-clone security.

Coverage rules (chosen so the scan never passes silently):
- At most MAX_FILES files are inspected. If a tree holds more, scanning stops
  and a fail-level `coverage-incomplete` finding is emitted instead of a pass.
- Text files larger than FULL_TEXT_LIMIT are not skipped: they are scanned
  with a chunked/streamed marker search (see `_scan_large_text`).
- `.json` files are sniffed for source-map keys at any size, also chunked.
"""
import argparse
import json
import re
import sys
from pathlib import Path

MAX_FILES = 100_000
FULL_TEXT_LIMIT = 10 * 1024 * 1024
CHUNK = 1024 * 1024

SCANNABLE_TEXT_EXTENSIONS = {
    '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
    '.css', '.html', '.htm', '.svg'
}

INLINE_SOURCEMAP_RE = re.compile(
    r'[#@]\s*sourceMappingURL\s*=\s*data:application/json(?:;charset=[^;,\s]+)?;base64,[A-Za-z0-9+/=]+',
    re.IGNORECASE,
)
EXTERNAL_SOURCEMAP_RE = re.compile(
    r'[#@]\s*sourceMappingURL\s*=\s*([^\s\'"]+)',
    re.IGNORECASE,
)
HEADERS_SOURCEMAP_RE = re.compile(r'^\s*SourceMap\s*:\s*\S+', re.IGNORECASE | re.MULTILINE)

MAP_FILENAME_SUFFIXES = ('.map', '.map.gz', '.map.br')


def _chunked_contains(path: Path, needles, case_insensitive: bool) -> set:
    """Stream `path` and return the subset of byte `needles` found anywhere in it."""
    wanted = [n.lower() if case_insensitive else n for n in needles]
    found = set()
    carry = b''
    longest = max(len(n) for n in wanted)
    with path.open('rb') as fh:
        while True:
            data = fh.read(CHUNK)
            if not data:
                break
            buf = carry + data
            haystack = buf.lower() if case_insensitive else buf
            for needle, original in zip(wanted, needles):
                if original not in found and needle in haystack:
                    found.add(original)
            carry = buf[-(longest - 1):] if longest > 1 else b''
            if len(found) == len(needles):
                break
    return found


def _scan_large_text(path: Path):
    """Chunked scan for `sourceMappingURL` markers in a file too large to load whole.

    Returns a list containing 'inline' and/or 'external' for each marker kind
    found. A marker only counts when it carries the same comment prefix the
    full-text regexes require (`#` or `@`, allowing blanks between), so stray
    occurrences of the word inside program code do not false-positive.
    """
    marker = b'sourcemappingurl'
    kinds = []
    carry = b''
    with path.open('rb') as fh:
        while True:
            data = fh.read(CHUNK)
            eof = not data
            buf = carry + data
            low = buf.lower()
            start = 0
            while True:
                idx = low.find(marker, start)
                if idx < 0:
                    break
                # Defer a marker too close to the buffer end: its tail (needed
                # for classification) arrives with the next chunk via carry.
                if not eof and idx + len(marker) + 160 > len(buf):
                    break
                # Require a `#`/`@` comment prefix just before the marker.
                j = idx - 1
                blanks = 0
                while j >= 0 and low[j:j + 1] in (b' ', b'\t') and blanks < 4:
                    j -= 1
                    blanks += 1
                if j < 0 or low[j:j + 1] not in (b'#', b'@'):
                    start = idx + len(marker)
                    continue
                tail = low[idx + len(marker): idx + len(marker) + 160].lstrip(b' \t\r\n=')
                kind = 'inline' if tail.startswith(b'data:') else 'external'
                if kind not in kinds:
                    kinds.append(kind)
                start = idx + len(marker)
                if len(kinds) == 2:
                    break
            if eof or len(kinds) == 2:
                break
            carry = buf[-4096:]
    return kinds


def _finding(path, severity, signal, rule):
    return {'path': path, 'severity': severity, 'signal': signal, 'rule': rule}


def scan(root: Path):
    results = []
    if not root.is_dir():
        raise ValueError('Supply an existing deployment asset directory')
    count = 0
    capped = False
    for f in root.rglob('*'):
        if f.is_symlink() or not f.is_file():
            continue
        count += 1
        if count > MAX_FILES:
            capped = True
            break
        path = f.relative_to(root).as_posix()
        name_lower = f.name.lower()
        suffix_lower = f.suffix.lower()
        size = f.stat().st_size
        if name_lower.endswith(MAP_FILENAME_SUFFIXES):
            results.append(_finding(path, 'fail', 'public-source-map', 'no-sourcemap-file'))
        elif name_lower == '_headers':
            if size <= FULL_TEXT_LIMIT:
                text = f.read_text(errors='replace')
                matched = HEADERS_SOURCEMAP_RE.search(text) is not None
            else:
                matched = bool(_chunked_contains(f, [b'sourcemap:'], case_insensitive=True))
            if matched:
                results.append(_finding(path, 'fail', 'sourcemap-response-header', 'no-sourcemap-header'))
        elif suffix_lower == '.json':
            # A source map renamed to .json still carries its tell-tale keys.
            found = _chunked_contains(f, [b'"mappings"', b'"sources"'], case_insensitive=False)
            if len(found) == 2:
                results.append(_finding(path, 'fail', 'renamed-source-map', 'no-renamed-sourcemap'))
        elif suffix_lower in SCANNABLE_TEXT_EXTENSIONS:
            if size <= FULL_TEXT_LIMIT:
                text = f.read_text(errors='replace')
                if INLINE_SOURCEMAP_RE.search(text):
                    results.append(_finding(path, 'fail', 'inline-source-map', 'no-inline-sourcemap'))
                elif EXTERNAL_SOURCEMAP_RE.search(text):
                    results.append(_finding(path, 'fail', 'external-source-map', 'no-external-sourcemap-ref'))
            else:
                for kind in _scan_large_text(f):
                    if kind == 'inline':
                        results.append(_finding(path, 'fail', 'inline-source-map', 'no-inline-sourcemap'))
                    else:
                        results.append(_finding(path, 'fail', 'external-source-map', 'no-external-sourcemap-ref'))
    if capped:
        results.append(_finding('.', 'fail', 'coverage-incomplete', 'scan-file-cap-exceeded'))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    try:
        findings = scan(args.directory)
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps({
        'directory': str(args.directory),
        'files_with_findings': len(findings),
        'findings': findings,
    }, indent=2))
    if any(f['severity'] == 'fail' for f in findings):
        sys.exit(1)


if __name__ == '__main__':
    main()
