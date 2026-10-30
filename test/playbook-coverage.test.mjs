import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { behavioralCases } from "../scripts/e2e/playbook-behavior.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const skill = resolve(repo, "skills/pi-flow-orchestration");
const runner = resolve(repo, "scripts/e2e/playbook-behavior.mjs");
const expectedPatterns = ["parallel-work", "batch-map-reduce", "pipeline", "routing", "discover-and-delegate", "independent-review", "bounded-refinement"];

describe("playbook coverage bookkeeping, not semantic proof", () => {
  it("keeps answer markers in source fixtures rather than user prompts", () => {
    for (const item of behavioralCases) {
      expect(item.goal.length).toBeGreaterThan(20);
      expect(item.review.length).toBeGreaterThan(0);
      const sources = Object.entries(item.files).map(([path, value]) => path + "\n" + value).join("\n");
      for (const path of Object.keys(item.files)) { expect(path).not.toContain(".."); expect(path).not.toMatch(/^\//); }
      for (const fact of item.expect.facts) {
        expect(sources, item.id).toContain(fact);
        expect(item.goal, item.id).not.toContain(fact);
      }
    }
  });

  it("forces a real oversized source and full paged-result oracle instead of relying on the tiny corpus", () => {
    const item = behavioralCases.find((item) => item.id === "large-output-inspection");
    expect(item).toBeDefined();
    expect(Buffer.byteLength(item.files[item.expect.requirePagedSource])).toBeGreaterThan(16384);
    expect(item.files[item.expect.requirePagedSource].split("\n")).toHaveLength(160);
  });

  it("self-checks oracles and the review hold without starting providers", () => {
    const result = spawnSync(process.execPath, [runner, "--selftest"], { encoding: "utf8", timeout: 30000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Selftest passed");
    expect(result.stdout).toContain("review");
  });

  it("lists live cases and requires explicit opt-in before running them", () => {
    const listing = spawnSync(process.execPath, [runner, "--list"], { encoding: "utf8", timeout: 30000 });
    expect(listing.status).toBe(0);
    for (const item of behavioralCases) expect(listing.stdout).toContain(item.id);
    const blocked = spawnSync(process.execPath, [runner], { encoding: "utf8", timeout: 30000 });
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toMatch(/--real|--out|--case/);
  });

  it("keeps the index small and guides reachable without claiming that a model chose them", () => {
    const index = readFileSync(resolve(skill, "SKILL.md"), "utf8");
    expect(index.length).toBeLessThan(5000);
    for (const pattern of expectedPatterns) {
      expect(index).toContain("patterns/" + pattern + ".md");
      expect(existsSync(resolve(skill, "patterns", pattern + ".md"))).toBe(true);
    }
  });
});
