#!/usr/bin/env python3
"""Check local handoff checksums and Markdown links. Standard library only."""
from pathlib import Path
from urllib.parse import unquote
import hashlib
import re
import sys
ROOT = Path(__file__).resolve().parents[1]
errors=[]
checksum_path=ROOT/'SHA256SUMS.txt'
if not checksum_path.exists():
    errors.append('Missing SHA256SUMS.txt')
else:
    for line in checksum_path.read_text().splitlines():
        if not line.strip(): continue
        digest, name=line.split('  ',1)
        path=(ROOT/name).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():
            errors.append('Missing or unsafe path: '+name)
        elif hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
            errors.append('Checksum mismatch: '+name)
for md in ROOT.rglob('*.md'):
    for target in re.findall(r'\[[^\]]*\]\(([^)]+)\)', md.read_text()):
        if re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:',target) or target.startswith('#'):
            continue
        clean=unquote(target.split('#',1)[0])
        if clean and not (md.parent/clean).resolve().exists():
            errors.append(f'Broken link in {md.relative_to(ROOT)}: {target}')
if errors:
    print('\n'.join(errors),file=sys.stderr)
    raise SystemExit(1)
print('PASS: package checksums and local Markdown links. External URLs were not fetched.')
