import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXTERNAL_SETTINGS,
  loadExternalSettings,
  resolveExternalSettings,
} from "../src/settings.ts";

const roots: string[] = [];
function agentDir(): string {
  const path = mkdtempSync(join(tmpdir(), "pi-flow-settings-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("external settings", () => {
  it("creates a private default file once", () => {
    const root = agentDir();
    const first = loadExternalSettings(root);
    const original = readFileSync(first.path, "utf8");

    expect(first.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(first.diagnostics).toEqual([]);
    expect(statSync(first.path).mode & 0o777).toBe(0o600);

    writeFileSync(first.path, original.replace("12", "7"));
    expect(loadExternalSettings(root).settings.maxConcurrentSubagents).toBe(7);
  });

  it("uses safe defaults and diagnostics for invalid files", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, '{"version":1,"maxConcurrentSubagents":0,"subagentTimeoutMs":"forever","extra":true}\n');

    const invalid = loadExternalSettings(root);
    expect(invalid.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(invalid.diagnostics.join(" ")).toMatch(/maxConcurrentSubagents|subagentTimeoutMs|Unknown setting/);
  });

  it("reports malformed JSON without preventing startup", () => {
    const root = agentDir();
    const loaded = loadExternalSettings(root);
    writeFileSync(loaded.path, "{broken\n");

    const malformed = loadExternalSettings(root);
    expect(malformed.settings).toEqual(DEFAULT_EXTERNAL_SETTINGS);
    expect(malformed.diagnostics[0]).toMatch(/valid JSON/);
  });

  it("resolves factory values over file values", () => {
    expect(resolveExternalSettings(
      { version: 1, maxConcurrentSubagents: 3, subagentTimeoutMs: 4_000 },
      { maxConcurrentSubagents: 5 },
    )).toEqual({ maxConcurrentSubagents: 5, subagentTimeoutMs: 4_000 });
  });
});
