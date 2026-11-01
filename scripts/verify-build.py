#!/usr/bin/env python3
"""Read-only static deployment-artifact scan. Usage: python3 scripts/verify-build.py dist-or-public-dir

Scan ONLY the exact directory that you intend to deploy publicly.
This detects common source map leaks, not actual privacy or anti-clone security.
"""
import argparse
import json
import re
import sys
from pathlib import Path

SCANNABLE_TEXT_EXTENSIONS = {
    '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
    '.css', '.html', '.htm'
}

INLINE_SOURCEMAP_RE = re.compile(
    r'[#@]\s*sourceMappingURL\s*=\s*data:application/json(?:;charset=[^;,\s]+)?;base64,[A-Za-z0-9+/=]+',
    re.IGNORECASE,
)
EXTERNAL_SOURCEMAP_RE = re.compile(
    r'[#@]\s*sourceMappingURL\s*=\s*([^\s\'"]+)',
    re.IGNORECASE,
)


def scan(root: Path):
    results = []
    if not root.is_dir():
        raise ValueError('Supply an existing deployment asset directory')
    count = 0
    for f in root.rglob('*'):
        if f.is_symlink() or not f.is_file():
            continue
        count += 1
        if count > 20000:
            raise ValueError('Too many files; restrict scan to publicly deployed asset directory')
        path = f.relative_to(root).as_posix()
        name_lower = f.name.lower()
        suffix_lower = f.suffix.lower()
        if name_lower.endswith('.map'):
            results.append({
                'path': path,
                'severity': 'fail',
                'signal': 'public-source-map',
                'rule': 'no-sourcemap-file',
            })
        elif suffix_lower in SCANNABLE_TEXT_EXTENSIONS and f.stat().st_size <= 10 * 1024 * 1024:
            text = f.read_text(errors='replace')
            if INLINE_SOURCEMAP_RE.search(text):
                results.append({
                    'path': path,
                    'severity': 'fail',
                    'signal': 'inline-source-map',
                    'rule': 'no-inline-sourcemap',
                })
            elif EXTERNAL_SOURCEMAP_RE.search(text):
                is_html = suffix_lower in ('.html', '.htm')
                results.append({
                    'path': path,
                    'severity': 'fail' if is_html else 'review',
                    'signal': 'html-sourceMappingURL' if is_html else 'sourceMappingURL-comment',
                    'rule': 'no-html-sourcemap-ref' if is_html else 'review-external-sourcemap-ref',
                })
        elif f.stat().st_size > 10 * 1024 * 1024:
            results.append({'path': path, 'severity': 'info', 'signal': 'large-file-not-inspected'})
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
