// Types for the plain-JS field-test runner's argument parser.
export function parseArgs(argv: string[]): {
  backend: string;
  harness?: string;
  model?: string;
  thinking?: string;
  permission: string;
  agentDir: string;
  agentDirProvided: boolean;
  runRoot: string;
  timeoutMs: number;
  routingSmoke: boolean;
  rootModel: string;
  rootThinking: string;
  workflow: boolean;
  interrupt: boolean;
  keep: boolean;
  help?: boolean;
};
