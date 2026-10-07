#!/usr/bin/env python3
"""Validate this handoff's draft contracts. Does not execute Flow or Pi."""
from __future__ import annotations
import json
import sys
from pathlib import Path
try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    print('Missing dependency: install jsonschema 4.x in an isolated Python environment.', file=sys.stderr)
    raise SystemExit(2)
ROOT = Path(__file__).resolve().parents[1]

def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)

def check_run(run: dict) -> None:
    expected = 'wf_' if run['kind'] == 'workflow' else 'run_'
    require(run['runId'].startswith(expected), 'run kind and ID prefix disagree')
    out = run['output']
    if out['finalAvailable']:
        require(run['state']['status'] == 'done', 'final output requires a done run')
    if out['delivery'] == 'inline':
        size = len(json.dumps(out['value'], ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))
        require(size <= 16 * 1024, 'inline canonical result exceeds proposed 16 KiB cap')
    if run['state']['status'] in ('queued', 'running'):
        require('outcome' not in run['state'], 'active run must not claim a terminal outcome')
    for ref in run['evidence']['refs']:
        require(ref['runId'] == run['runId'], 'evidence reference targets another run')

def semantics(case: dict) -> None:
    r = case['receipt']
    require(case['hostIsError'] == (not r['ok']), 'host isError disagrees with receipt ok')
    data = r['data']
    if data is None:
        require(not r['ok'], 'successful operation requires data')
        return
    if r['tool'] in ('Agent', 'workflow'):
        run = data['run']
        if r['ok']:
            require(run is not None, 'successful launch must have a registered run')
        if run is not None:
            check_run(run)
            require(run['kind'] == ('agent' if r['tool'] == 'Agent' else 'workflow'), 'tool and run kind disagree')
            if not r['ok'] and 'runId' in r['error']:
                require(r['error']['runId'] == run['runId'], 'error and retained run IDs disagree')
        return
    for key in ('runs', 'workflows', 'entries', 'completed'):
        for run in data.get(key, []):
            check_run(run)
    if r['tool'] == 'external_runs' and r['action'] == 'wait':
        completed = [x['runId'] for x in data['completed']]
        require(len(set(completed)) == len(completed), 'duplicate completed targets')
        require(len(set(data['pending'])) == len(data['pending']), 'duplicate pending targets')
        require(not set(completed).intersection(data['pending']), 'completed targets overlap pending targets')
    if r['tool'] == 'external_runs' and r['action'] == 'inspect' and data['mode'] == 'single':
        page = data['page']
        require(page['complete'] == ('nextCursor' not in page), 'page completion and continuation disagree')
        if data.get('finalAvailable') is False and data['view'] == 'final':
            require(page['text'] == '', 'unavailable final must not contain synthesized or partial answer')
        if page['complete'] and page['encoding'] == 'json' and page['text']:
            json.loads(page['text'])

def main() -> int:
    schema = json.loads((ROOT / 'contracts/flow-result.schema.json').read_text())
    cases = json.loads((ROOT / 'contracts/fixtures.json').read_text())
    Draft202012Validator.check_schema(schema)
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    failures = []
    for case in cases:
        errors = list(validator.iter_errors(case['receipt']))
        why = '; '.join(e.message for e in errors[:2])
        if not errors:
            try:
                semantics(case)
            except (ValueError, KeyError, TypeError) as exc:
                why = str(exc)
        actual_valid = not bool(why)
        if actual_valid != case['valid']:
            failures.append(f"{case['name']}: expected valid={case['valid']}; observed valid={actual_valid}; {why}")
    if failures:
        print('\n'.join(failures), file=sys.stderr)
        return 1
    positive = sum(c['valid'] for c in cases)
    print(f'PASS: {len(cases)} draft fixtures ({positive} accepted, {len(cases)-positive} rejected as intended).')
    print('Package contracts only. No Flow/Pi integration, repository suite, or provider test was run.')
    return 0
if __name__ == '__main__':
    raise SystemExit(main())
