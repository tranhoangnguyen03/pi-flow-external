export function readSettingsFile(agentDir: string):
  | { settingsPath: string; missing: true; parsed?: never }
  | { settingsPath: string; missing: false; parsed: Record<string, any> };
export function preflightPiHarness(agentDir: string, harnessName: string): void;
