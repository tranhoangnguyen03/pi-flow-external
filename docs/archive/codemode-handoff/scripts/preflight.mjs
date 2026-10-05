#!/usr/bin/env node
/** Read-only checkout inspection. Never fetches, installs, edits, or invokes a provider. */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/preflight.mjs /path/to/pi-flow-external [--allow-drift]');
  console.log('Read-only: reports version, checkout identity, expected files, and existing changes.');
  process.exit(0);
}
const positional = args.filter(a => !a.startsWith('--'));
if (positional.length !== 1 || args.some(a => a.startsWith('--') && a !== '--allow-drift')) {
  console.error('Usage: node scripts/preflight.mjs /path/to/pi-flow-external [--allow-drift]');
  process.exit(2);
}
const expected = 'ae04c8883470dcc16995f75ea2a39b5b32e729db';
const repo = resolve(positional[0]);
const required = ['AGENTS.md', 'README.md', 'CONTEXT.md', 'package.json', 'src/pi-subagent.ts',
  'src/external-help.ts', 'src/external-runs.ts', 'src/core/run-projection.ts',
  'src/core/parent-context.ts', 'src/workflow/tool.ts', 'src/workflow/runtime.ts',
  'src/workflow/script-worker.ts', 'src/workflow/source.ts'];
try {
  const missing = required.filter(p => !existsSync(join(repo, p)));
  if (missing.length) throw new Error(`Missing expected source files: ${missing.join(', ')}`);
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  if (pkg.name !== '@tranhoangnguyen0310/pi-flow-external') throw new Error('Package identity does not match the target repository');
  const git = (...argv) => execFileSync('git', ['-C', repo, ...argv], {
    encoding: 'utf8', env: {...process.env, GIT_OPTIONAL_LOCKS:'0'}, maxBuffer: 4 * 1024 * 1024,
  }).trim();
  const head = git('rev-parse', 'HEAD');
  const state = git('status', '--short');
  const parts = process.versions.node.split('.').map(Number);
  const nodeOK = parts[0] > 22 || (parts[0] === 22 && (parts[1] > 19 || (parts[1] === 19 && parts[2] >= 0)));
  console.log(JSON.stringify({
    repository:repo, head, inspectedBaseline:expected, sourceDrift:head !== expected,
    packageVersion:pkg.version, node:process.versions.node, nodeMeetsBaseline:nodeOK,
    piDevPin:pkg.devDependencies?.['@earendil-works/pi-coding-agent'] ?? null,
    workingTree:state || '(clean)', baselineCommand:pkg.scripts?.check ?? null,
    testsRun:false, writesPerformed:false,
  }, null, 2));
  if (!nodeOK) {
    console.error('Baseline Flow requires Node >=22.19.0. Use a suitable isolated environment.');
    process.exitCode = 2;
  }
  if (head !== expected && !args.includes('--allow-drift')) {
    console.error('HEAD differs from the inspected source. Review the diff; do not reset it. Rerun with --allow-drift after reconciliation.');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
