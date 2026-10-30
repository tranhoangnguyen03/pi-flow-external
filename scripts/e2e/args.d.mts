/** Types for the standalone E2E CLI parser used by TypeScript tests. */
export interface E2EArguments {
  backend: string;
  routingSmoke: boolean;
  rootModel: string;
  rootThinking: string;
  runRoot: string;
  timeoutMs: number;
  workflow: boolean;
  interrupt: boolean;
  keep: boolean;
  permission: "readonly" | "edit" | "danger";
  agentDir: string;
  agentDirProvided: boolean;
  harness?: string;
  model?: string;
  thinking?: string;
  help?: boolean;
}
export function parseArgs(argv: string[]): E2EArguments;
