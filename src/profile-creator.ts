import { randomUUID } from "node:crypto";
import { access, link, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import type { ConcurrencyLimiter } from "./core/concurrency.ts";
import { textResult } from "./core/progress.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import {
  filterExternalAgentProfiles,
  getSubagentProfiles,
  isExternalAgentProfile,
  isValidSubagentName,
  parseSubagentProfileContent,
} from "./profiles.ts";
import type { SubagentProfile, SubagentUsage } from "./types.ts";

const PROFILE_TOOL_NAME = "pi_flow_profile_create";
const SMOKE_TOKEN = "PI_FLOW_PROFILE_OK";

export const PROFILE_INTERVIEW_PROMPT = `Help me create one pi-flow external agent profile through an AI-assisted interview.

Start by asking: "What kind of agent do you want to create, and what should it help you accomplish?"
Then ask one question at a time, only when the answer is not already known. Collect enough information to write a focused profile: its intended work, boundaries (especially read-only versus file modification), useful output, validation expectations, and stop/escalation rules.

When the intent is clear, recommend a backend: claude, codex, or agy. Briefly explain the recommendation and let me override it. Suggest a lowercase backend-qualified profile name. Ask about model and thinking only when I want to pin them; otherwise omit them.

When the profile is ready, summarize your understanding once. Then call ${PROFILE_TOOL_NAME}. Do not write files yourself and do not run Agent or workflow. The tool will show the exact profile for review, request confirmation, stage it, run the real backend smoke test, and either install it or roll it back.`;

const profileParameters = Type.Object({
  name: Type.String({ description: "Lowercase backend-qualified profile name, such as claude-security-reviewer." }),
  description: Type.String({ description: "Concise profile description shown in the available-agent roster." }),
  backend: StringEnum(["claude", "codex", "agy"] as const, { description: "External CLI backend." }),
  model: Type.Optional(Type.String({ description: "Optional backend model override. Omit to use the CLI default." })),
  thinking: Type.Optional(Type.String({ description: "Optional reasoning-effort override. Omit to use the current Pi level." })),
  systemPrompt: Type.String({ description: "Complete focused instructions for the external agent profile." }),
});

type ProfileParameters = Static<typeof profileParameters>;

interface ProfileCreatorOptions {
  getLimiter: () => ConcurrencyLimiter;
  getSubagentTimeoutMs: () => number;
  getThinkingLevel: () => ReturnType<ExtensionAPI["getThinkingLevel"]>;
  updateStatus: (ctx: ExtensionContext, toolCallId: string, usage: SubagentUsage) => void;
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeProfile(input: ProfileParameters): SubagentProfile {
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    backend: input.backend,
    model: optional(input.model),
    thinking: optional(input.thinking),
    systemPrompt: input.systemPrompt.trim(),
  };
}

export function compileProfile(profile: SubagentProfile): string {
  if (!isValidSubagentName(profile.name)) {
    throw new Error("Profile name must contain only lowercase letters, numbers, and hyphens.");
  }
  if (!isExternalAgentProfile(profile)) {
    throw new Error("Profile backend must be claude, codex, or agy.");
  }
  const backendPrefix = `${profile.backend}-`;
  if (!profile.name.startsWith(backendPrefix) || profile.name === backendPrefix) {
    throw new Error(`Profile name must start with ${JSON.stringify(backendPrefix)}.`);
  }
  if (!profile.description.trim()) {
    throw new Error("Profile description is required.");
  }
  if (!profile.systemPrompt?.trim()) {
    throw new Error("Profile instructions are required.");
  }

  const frontmatter = [
    `description: ${JSON.stringify(profile.description.trim())}`,
    `backend: ${profile.backend}`,
    ...(profile.model ? [`model: ${JSON.stringify(profile.model)}`] : []),
    ...(profile.thinking ? [`thinking: ${JSON.stringify(profile.thinking)}`] : []),
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${profile.systemPrompt.trim()}\n`;
}

export async function installProfileWithSmokeTest({
  agentDir,
  profile,
  signal,
  smokeTest,
}: {
  agentDir: string;
  profile: SubagentProfile;
  signal?: AbortSignal;
  smokeTest: () => Promise<{ ok: true } | { ok: false; error: string }>;
}): Promise<string> {
  const content = compileProfile(profile);
  if (!parseSubagentProfileContent(content, profile.name, { requireBody: true })) {
    throw new Error("Compiled profile failed runtime validation.");
  }
  if (getSubagentProfiles(agentDir).has(profile.name)) {
    throw new Error(`Profile "${profile.name}" already exists.`);
  }

  const dir = join(agentDir, "subagents");
  const finalPath = join(dir, `${profile.name}.md`);
  const stagedPath = join(dir, `.${profile.name}.${process.pid}.${randomUUID()}.staged`);
  let finalCreated = false;
  await mkdir(dir, { recursive: true });
  try {
    await access(finalPath);
    throw new Error(`Profile "${profile.name}" already exists.`);
  } catch (error) {
    if (error instanceof Error && !((error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }

  try {
    await writeFile(stagedPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    const smoke = await smokeTest();
    if (!smoke.ok) {
      throw new Error(smoke.error);
    }
    signal?.throwIfAborted();
    // Hard-linking is an atomic, no-overwrite install because staging and final
    // paths share a directory. Remove the staged name after the link succeeds.
    await link(stagedPath, finalPath);
    finalCreated = true;
    await unlink(stagedPath);
    signal?.throwIfAborted();

    const installed = filterExternalAgentProfiles(getSubagentProfiles(agentDir)).get(profile.name);
    if (!installed) {
      throw new Error("Installed profile was not discovered by the runtime loader.");
    }
    return finalPath;
  } catch (error) {
    const cleanupErrors: string[] = [];
    const remove = async (path: string) => {
      try {
        await unlink(path);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupErrors.push(`${path}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
    };
    await remove(stagedPath);
    if (finalCreated) {
      await remove(finalPath);
    }
    if (cleanupErrors.length > 0) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message} Rollback incomplete; remove the residual file(s) manually: ${cleanupErrors.join("; ")}`);
    }
    throw error;
  }
}

function smokePrompt(): string {
  return `This is a profile readiness smoke test. Do not inspect, create, modify, or delete files. Reply with exactly ${SMOKE_TOKEN} and nothing else.`;
}

function resultText(result: Awaited<ReturnType<typeof spawnSubagent>>): string | undefined {
  const details = result.details as { result?: string };
  return details.result;
}

function profileReview(profile: SubagentProfile, path: string): string {
  return `Destination: ${path}\nBackend executable: ${profile.backend}\n\n${compileProfile(profile)}\nThe smoke test omits these profile instructions and launches this backend in its configured no-approval mode from an empty temporary working directory.`;
}

export function registerProfileCreator(pi: ExtensionAPI, options: ProfileCreatorOptions): void {
  pi.registerTool(defineTool({
    name: PROFILE_TOOL_NAME,
    label: "Create pi-flow profile",
    description: "Finalize a profile after the /pi-flow-profile create interview. Shows the compiled profile for user confirmation, smoke-tests the real external backend, and rolls back on failure.",
    parameters: profileParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const profile = normalizeProfile(params);
      const finalPath = join(getAgentDir(), "subagents", `${profile.name}.md`);
      try {
        compileProfile(profile);
      } catch (error) {
        return textResult(`Profile validation failed: ${error instanceof Error ? error.message : String(error)}`, {
          description: "Create pi-flow profile",
          subagentType: profile.name || "unknown",
          backend: profile.backend,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!ctx.hasUI) {
        return textResult("Profile creation requires interactive or RPC UI so the compiled file can be reviewed and confirmed.", {
          description: "Create pi-flow profile",
          subagentType: profile.name,
          backend: profile.backend,
          status: "error",
          error: "Review UI unavailable",
        });
      }

      const confirmed = await ctx.ui.confirm(
        `Create ${profile.name}?`,
        profileReview(profile, finalPath),
        { signal },
      );
      if (!confirmed) {
        return textResult("Profile creation cancelled. No profile was created.", {
          description: "Create pi-flow profile",
          subagentType: profile.name,
          backend: profile.backend,
          status: "aborted",
        });
      }

      try {
        const createdPath = await installProfileWithSmokeTest({
          agentDir: getAgentDir(),
          profile,
          signal,
          smokeTest: async () => {
            let release: () => void;
            try {
              release = await options.getLimiter().acquire(signal);
            } catch (error) {
              if (signal?.aborted) {
                throw new DOMException(error instanceof Error ? error.message : String(error), "AbortError");
              }
              throw error;
            }
            let smokeDir: string | undefined;
            try {
              smokeDir = await mkdtemp(join(tmpdir(), "pi-flow-profile-smoke-"));
              const result = await spawnSubagent({
                toolCallId: `${toolCallId}-smoke`,
                description: "Profile smoke test",
                prompt: smokePrompt(),
                // Validate backend availability/auth/model without executing the
                // new profile's instructions or loading project instructions.
                profile: { ...profile, systemPrompt: undefined },
                thinkingLevel: profile.backend === "agy"
                  ? undefined
                  : profile.thinking ?? options.getThinkingLevel(),
                ctx: { ...ctx, cwd: smokeDir },
                signal,
                timeoutMs: options.getSubagentTimeoutMs(),
                progressEnabled: false,
                onProgress: undefined,
                onUsage: (usage) => options.updateStatus(ctx, toolCallId, usage),
                excludeTools: CHILD_EXCLUDED_TOOLS,
              });
              const details = result.details as { status?: string; error?: string };
              if (details.status === "aborted") {
                throw new DOMException(details.error ?? "Profile smoke test cancelled.", "AbortError");
              }
              if (details.status !== "done") {
                return { ok: false, error: details.error ?? `Smoke test ended with status ${details.status ?? "unknown"}.` };
              }
              if (resultText(result) !== SMOKE_TOKEN) {
                return { ok: false, error: `Smoke test returned an unexpected response instead of ${SMOKE_TOKEN}.` };
              }
              return { ok: true };
            } finally {
              release();
              if (smokeDir) {
                await rm(smokeDir, { recursive: true, force: true });
              }
            }
          },
        });
        ctx.ui.notify(`Profile "${profile.name}" is ready: ${createdPath}`, "info");
        return textResult(`Profile "${profile.name}" passed its smoke test and was installed at ${createdPath}.`, {
          description: "Create pi-flow profile",
          subagentType: profile.name,
          backend: profile.backend,
          status: "done",
          result: createdPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        const rollbackIncomplete = message.includes("Rollback incomplete;");
        const existingProfile = message === `Profile "${profile.name}" already exists.`;
        if (cancelled) {
          ctx.ui.notify("Profile creation cancelled. No profile was created.", "info");
          return textResult("Profile creation cancelled. No profile was created.", {
            description: "Create pi-flow profile",
            subagentType: profile.name,
            backend: profile.backend,
            status: "aborted",
            error: message,
          });
        }
        ctx.ui.notify(
          rollbackIncomplete
            ? `Profile creation failed; rollback is incomplete: ${message}`
            : existingProfile
              ? `Profile creation failed: ${message} The existing profile was not changed.`
              : `Profile creation failed and was rolled back: ${message}`,
          "error",
        );
        return textResult(
          rollbackIncomplete
            ? `Profile creation failed during validation or smoke testing: ${message}`
            : existingProfile
              ? `Profile creation failed: ${message}\n\nThe existing profile was not changed.`
              : `Profile creation failed during validation or smoke testing: ${message}\n\nRolled back. No profile was created.`, {
          description: "Create pi-flow profile",
          subagentType: profile.name,
          backend: profile.backend,
          status: "error",
          error: message,
        });
      }
    },
  }));

  pi.registerCommand("pi-flow-profile", {
    description: "Create an external agent profile through an AI-assisted interview",
    getArgumentCompletions: (prefix) => "create".startsWith(prefix.trim())
      ? [{ value: "create", label: "create", description: "Start an AI-assisted profile interview" }]
      : null,
    handler: async (args, ctx) => {
      if (args.trim() !== "create") {
        ctx.ui.notify("Usage: /pi-flow-profile create", "warning");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Profile creation requires interactive or RPC mode.", "error");
        return;
      }
      if (!ctx.model) {
        ctx.ui.notify("Select a Pi model before starting the profile interview.", "error");
        return;
      }

      const result = await ctx.newSession({
        parentSession: ctx.sessionManager.getSessionFile(),
        withSession: async (newCtx) => {
          await newCtx.sendUserMessage(PROFILE_INTERVIEW_PROMPT);
        },
      });
      if (result.cancelled) {
        ctx.ui.notify("Profile interview cancelled.", "info");
      }
    },
  });
}
