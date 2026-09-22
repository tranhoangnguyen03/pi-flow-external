import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCapabilitySelection } from "../src/core/capabilities.ts";

const roots: string[] = [];
function tempRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function writeGlobalSkill(agentDir: string, name: string, description: string, body = "Do the thing."): string {
  const dir = join(agentDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
  return path;
}

function writeGlobalPrompt(agentDir: string, name: string, description: string, body = "Do the thing."): string {
  const dir = join(agentDir, "prompts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.md`);
  writeFileSync(path, `---\ndescription: ${description}\n---\n\n${body}\n`);
  return path;
}

describe("resolveCapabilitySelection", () => {
  it("resolves exactly the selected skill and prompt template names, ignoring unselected ones", async () => {
    const agentDir = tempRoot("pi-flow-caps-agent-");
    const cwd = tempRoot("pi-flow-caps-cwd-");
    writeGlobalSkill(agentDir, "writer", "Writes docs.");
    writeGlobalSkill(agentDir, "other-skill", "Unrelated skill, must not be selected.");
    writeGlobalPrompt(agentDir, "release-notes", "Draft release notes.");

    const resolved = await resolveCapabilitySelection({
      cwd,
      agentDir,
      projectTrusted: false,
      set: "docs",
      capabilitySet: { skills: ["writer"], promptTemplates: ["release-notes"] },
    });
    expect(resolved.set).toBe("docs");
    expect(resolved.skills).toEqual(["writer"]);
    expect(resolved.promptTemplates).toEqual(["release-notes"]);
  });

  it("hashes stably across repeated calls when nothing on disk changes", async () => {
    const agentDir = tempRoot("pi-flow-caps-agent-");
    const cwd = tempRoot("pi-flow-caps-cwd-");
    writeGlobalSkill(agentDir, "writer", "Writes docs.");
    const params = { cwd, agentDir, projectTrusted: false, set: "docs", capabilitySet: { skills: ["writer"], promptTemplates: [] } };
    const first = await resolveCapabilitySelection(params);
    const second = await resolveCapabilitySelection(params);
    expect(second.contentHash).toBe(first.contentHash);
  });

  it("fails before any session exists when a selected skill or prompt template is not discoverable", async () => {
    const agentDir = tempRoot("pi-flow-caps-agent-");
    const cwd = tempRoot("pi-flow-caps-cwd-");
    writeGlobalSkill(agentDir, "writer", "Writes docs.");

    await expect(
      resolveCapabilitySelection({
        cwd,
        agentDir,
        projectTrusted: false,
        set: "docs",
        capabilitySet: { skills: ["writer", "missing-skill"], promptTemplates: ["missing-template"] },
      }),
    ).rejects.toThrow(/missing-skill/);
  });

  it("only discovers project-scope skills when the project is trusted", async () => {
    const agentDir = tempRoot("pi-flow-caps-agent-");
    const cwd = tempRoot("pi-flow-caps-cwd-");
    const projectSkillDir = join(cwd, ".pi", "skills", "project-writer");
    mkdirSync(projectSkillDir, { recursive: true });
    writeFileSync(
      join(projectSkillDir, "SKILL.md"),
      "---\nname: project-writer\ndescription: Project-only writer.\n---\n\nWrite.\n",
    );
    const params = { cwd, agentDir, set: "docs", capabilitySet: { skills: ["project-writer"], promptTemplates: [] } };

    await expect(resolveCapabilitySelection({ ...params, projectTrusted: false })).rejects.toThrow(/project-writer/);
    const resolved = await resolveCapabilitySelection({ ...params, projectTrusted: true });
    expect(resolved.skills).toEqual(["project-writer"]);
  });

  it("changes the content hash when a selected SKILL.md's content is edited", async () => {
    const agentDir = tempRoot("pi-flow-caps-agent-");
    const cwd = tempRoot("pi-flow-caps-cwd-");
    const path = writeGlobalSkill(agentDir, "writer", "Writes docs.");
    const params = { cwd, agentDir, projectTrusted: false, set: "docs", capabilitySet: { skills: ["writer"], promptTemplates: [] } };
    const before = await resolveCapabilitySelection(params);
    writeFileSync(path, "---\nname: writer\ndescription: Writes docs, now differently.\n---\n\nDo something else.\n");
    const after = await resolveCapabilitySelection(params);
    expect(after.contentHash).not.toBe(before.contentHash);
  });

  it("resolves to nothing selected for an empty capabilitySet (defaults unchanged)", async () => {
    const agentDir = tempRoot("pi-flow-caps-agent-");
    const cwd = tempRoot("pi-flow-caps-cwd-");
    writeGlobalSkill(agentDir, "writer", "Writes docs.");
    const resolved = await resolveCapabilitySelection({
      cwd,
      agentDir,
      projectTrusted: false,
      set: "empty",
      capabilitySet: { skills: [], promptTemplates: [] },
    });
    expect(resolved.skills).toEqual([]);
    expect(resolved.promptTemplates).toEqual([]);
  });
});
