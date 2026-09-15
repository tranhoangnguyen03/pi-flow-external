import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const installedVersion = (JSON.parse(
  readFileSync(join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8"),
) as { version: string }).version;

describe("resolvePiCodingAgentVersion", () => {
  it("resolves the actually installed pinned SDK version, not a hardcoded guess", async () => {
    const { resolvePiCodingAgentVersion } = await import("../src/workflow/replay-cache.ts");
    expect(resolvePiCodingAgentVersion()).toBe(installedVersion);
  });

  it("includes the resolved version in the fingerprint policy tag", async () => {
    const { WORKFLOW_FINGERPRINT_POLICY_VERSION } = await import("../src/workflow/replay-cache.ts");
    expect(WORKFLOW_FINGERPRINT_POLICY_VERSION).toContain(installedVersion);
    expect(WORKFLOW_FINGERPRINT_POLICY_VERSION).toContain("tier-tools-v1");
  });

  it("degrades to 'unknown' rather than throwing when resolution fails", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return { ...actual, existsSync: () => false };
    });
    try {
      const { resolvePiCodingAgentVersion } = await import("../src/workflow/replay-cache.ts");
      expect(resolvePiCodingAgentVersion()).toBe("unknown");
    } finally {
      vi.doUnmock("node:fs");
      vi.resetModules();
    }
  });
});

describe("fingerprintWorkflowAgentCall policy version participation", () => {
  it("changes the fingerprint when the descriptor is present vs. absent, carrying the policy tag along with it", async () => {
    const { fingerprintWorkflowAgentCall } = await import("../src/workflow/replay-cache.ts");
    const call = { cwd: "/tmp", prompt: "p", label: "l", subagentType: "x" };
    const withoutDescriptor = fingerprintWorkflowAgentCall(call);
    const withDescriptor = fingerprintWorkflowAgentCall(call, { backend: "pi" });
    expect(withoutDescriptor).not.toBe(withDescriptor);
  });
});
