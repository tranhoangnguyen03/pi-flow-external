export function readSettingsFile(agentDir: string): { settingsPath: string; missing: boolean; parsed?: Record<string, any> };
export function preflightPiHarness(agentDir: string, harnessName: string): void;
