#!/usr/bin/env python3
"""Turn machine evidence into a human-readable Markdown report without fictional data."""
import json,pathlib,datetime,sys
root=pathlib.Path(__file__).resolve().parent
p=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else root/'results'/'browser.json'
if not p.is_file():raise SystemExit('No Playwright evidence; run python benchmark/run_all.py')
d=json.loads(p.read_text())
lines=['# antiRea 2.1 — Browser benchmark evidence','',f"Generated: {d['timestamp_utc']}",'',
  '> **Scope:** controlled twin-SaaS lab only. This is NOT a measurement of REA defeating/being defeated or protection from independent clones.','',
  '| Engine | Mode | Functional/fixture assertions | Median load (ms) | Export HTTP statuses | JS errors |','|---|---|---:|---:|---|---|']
for s in d['scenarios']:
 if 'error' in s:lines.append(f"| {s['engine']} | {s['mode']} | ERROR | — | — | {s['error'].splitlines()[0][:130].replace('|','/')} |")
 else:lines.append(f"| {s['engine']} | {s['mode']} | {s['passed']}/{s['total']} | {s['load_ms_median']} | {','.join(map(str,s['export_probe_http_statuses']))} | {len(s['page_errors'])} |")
lines+=['','## Metric interpretations','',
 '- Server export limit: A `429` means the controlled benchmark server enforced an export threshold. It does not mean the browser UI/API is unobservable.',
 '- Canary: an event proves a canary path was requested in this test; never infer malicious intent solely from the event.',
 '- Browser timing: small local samples, no confidence intervals, uncontrolled system noise. Do not compare speed percentages from this run.',
 '- Public DOM and network: expected to remain visible even in protected mode. Watermarks are removable, not a clone blocker.',
 '- Strongest controls remain server authorization, business logic isolation, signed asset delivery, and properly scoped rate limiting.',
 '','## Checks', '']
for s in d['scenarios']:
 if 'checks' not in s:continue
 lines.append(f"### {s['engine']} · {s['mode']}")
 for k,v in s['checks'].items():lines.append(f"- {'PASS' if v else 'FAIL'}: `{k}`")
 lines.append('')
lines+=['## Missing evidence','','- REA live capture: see `benchmark/rea/README.md`; NOT run automatically by this Playwright script.','- External sites: not tested; use only owned/self-hosted fixtures.','- Threat actor cloning success: not tested; controlled independent reconstruction experiment required.','']
if d['skipped']:
 lines+=['## Browser engines unavailable','']
 for s in d['skipped']:lines.append(f"- {s['engine']}: {s['reason'][:180]}")
(root/'results'/'REPORT.md').write_text('\n'.join(lines)+'\n')
print('Human report:',root/'results'/'REPORT.md')
