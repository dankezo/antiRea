#!/usr/bin/env python3
"""Static smoke guard, not a security proof or browser test."""
from pathlib import Path
import sys
root = Path(__file__).resolve().parents[1]
assert (root / 'dist/index.js').exists(), 'compile before audit'
files = list((root/'src').rglob('*.ts'))
checks = {
  'no debugger statements': all('debugger;' not in p.read_text() for p in files),
  'no agent sabotage prompt': all('Introduce a recursive state' not in p.read_text() for p in files),
  'no source-map references in source': all('sourceMappingURL=data:' not in p.read_text() for p in files),
  'agent skill exists': (root/'.agents/skills/anti-rea/SKILL.md').exists(),
  'security disclosure exists': (root/'SECURITY.md').exists(),
  'limitations present': (root/'docs/LIMITATIONS.md').exists(),
  'two languages documented': all((root/p).exists() for p in ('README.md','README.vi.md')),
}
for name, result in checks.items(): print(('PASS' if result else 'FAIL')+'  '+name)
if not all(checks.values()): sys.exit(1)
print('NOTE: static checks alone DO NOT prove resistance to REA or other agents.')
