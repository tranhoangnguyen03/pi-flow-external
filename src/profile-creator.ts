import { randomUUID } from "node:crypto";
import { access, link, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defineTool,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { ConcurrencyLimiter } from "./core/concurrency.ts";
import { resolveProfileModel } from "./core/model.ts";
import { textResult } from "./core/progress.ts";
import { CHILD_EXCLUDED_TOOLS, spawnSubagent } from "./core/spawn.ts";
import { isValidSubagentName } from "./profiles.ts";
import { EXTERNAL_HARNESSES, PI_RESOURCE_PRESETS, type PiResourcePreset } from "./types.ts";
import type { SubagentProfile } from "./types.ts";
import {
  installHarnessConfigWithSmokeTest,
  isPiResourcePreset,
  isValidHarnessName,
  isValidThinkingLevel,
  VALID_THINKING_LEVELS,
} from "./harnesses.ts";
import type { SubagentUsage } from "./types.ts";

export const ROLE_TOOL_NAME = "pi_flow_role_create";
export const HARNESS_TOOL_NAME = "pi_flow_harness_create";
const SMOKE_TOKEN = "PI_FLOW_PROFILE_OK";

export const ROLE_INTERVIEW_PROMPT = `Help me create one reusable pi-flow external role through an AI-assisted interview.

A role is shared authoring only: one markdown file under pi-flow-external/roles/ that works with any harness (agy, claude, codex, grok, muse, or a registered pi-* harness). Ask one question at a time, only when the answer is not already known. Collect enough information to write a focused role: its intended work, boundaries (especially read-only versus file modification), useful output, validation expectations, and stop/escalation rules. Suggest a lowercase role name such as security-reviewer (no backend prefix; naming it reviewer replaces the built-in reviewer across harnesses).

Describe read-only or editing intent in the instructions. Do not ask for a permission tier: a role does not grant authority. The caller passes permission, or the global defaultPermission applies. Do not ask about backend, model, or thinking: shared roles never pin those, and backend-specific customizations belong in an exact override created later via /external role override. When ready, summarize once and call ${ROLE_TOOL_NAME}.

Do not write files yourself and do not run Agent or workflow. The tool will show what will be created for review, request confirmation, and write it offline without a backend smoke test. A role is not an authenticated connection; readiness smoke testing belongs to harness registration.`;

export const HARNESS_INTERVIEW_PROMPT = `Help me register one named Pi harness configuration through an AI-assisted interview.

Ask for a "pi-<label>" name, a provider/model id (validated live against the model registry), an optional thinking level (off/minimal/low/medium/high/xhigh; default off), and a resource preset. The preset is a simple choice of minimal or skills. minimal is the default and loads no skills. skills loads installed skills; project skills load only when the project is trusted. The six canonical roles (explorer, planner, implementer, reviewer, qa, worker) become automatically available on this harness the moment it is registered — no per-role file needed. When ready, summarize once and call ${HARNESS_TOOL_NAME}.

Do not write files yourself and do not run Agent or workflow in this branch. The tool will show what will be registered for review, request confirmation, stage it, run a real in-process pi smoke test, and either install it or roll it back.`;

const roleParameters = Type.Object({
  name: Type.String({ description: "Lowercase shared role name, such as security-reviewer. No backend prefix; reviewer replaces the built-in reviewer." }),
  description: Type.String({ description: "Concise role description shown by external_help and in delegation intent." }),
  systemPrompt: Type.String({ description: "Complete focused instructions for the shared role. Describe intent, including whether the work should stay read-only. This does not set execution authority." }),
});

type RoleParameters = Static<typeof roleParameters>;

type _AssertTrue<T extends true> = T;
type _PresetSchemaIsPair = _AssertTrue<typeof PI_RESOURCE_PRESETS extends readonly [PiResourcePreset, PiResourcePreset] ? true : false>;

const harnessParameters = Type.Object({
  name: Type.String({ description: "Lowercase pi-<label> harness name, such as pi-deepseek." }),
  model: Type.String({ description: "provider/modelId, resolved live against the Pi model registry, such as deepseek/deepseek-chat." }),
  thinking: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, or xhigh. Defaults to off." })),
  preset: Type.Optional(Type.Union([
    Type.Literal(PI_RESOURCE_PRESETS[0]),
    Type.Literal(PI_RESOURCE_PRESETS[1]),
  ], { description: "Resource preset. minimal loads no skills. skills loads installed skills; project skills load only when the project is trusted. Defaults to minimal." })),
});

type HarnessParameters = Static<typeof harnessParameters>;

export interface SharedRole {
  name: string;
  description: string;
  systemPrompt: string;
}

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

export function rolesDir(agentDir: string): string {
  return join(agentDir, "pi-flow-external", "roles");
}

export function sharedRolePath(agentDir: string, name: string): string {
  return join(rolesDir(agentDir), `${name}.md`);
}

function normalizeSharedRole(input: RoleParameters): SharedRole {
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    systemPrompt: input.systemPrompt.trim(),
  };
}

/**
 * Compile a shared role to its canonical markdown. Shared roles carry only
 * description; backend/model/thinking/permission/owner fields belong elsewhere
 * and are rejected by the catalog loader.
 */
export function compileSharedRole(role: SharedRole): string {
  if (!isValidSubagentName(role.name)) {
    throw new Error("Role name must contain only lowercase letters, numbers, and hyphens.");
  }
  if (!role.description.trim()) {
    throw new Error("Role description is required.");
  }
  if (!role.systemPrompt?.trim()) {
    throw new Error("Role instructions are required.");
  }
  const frontmatter = [
    `description: ${JSON.stringify(role.description.trim())}`,
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${role.systemPrompt.trim()}\n`;
}

/**
 * Serialize an exact execution profile to its canonical markdown: description,
 * backend/harness, model/thinking, tools, budget, and owner, plus the
 * instruction body. permission and capabilitySet are obsolete and are not written.
 */
export function compileProfile(profile: SubagentProfile): string {
  if (!isValidSubagentName(profile.name)) {
    throw new Error("Profile name must contain only lowercase letters, numbers, and hyphens.");
  }
  const isExternalCli = (EXTERNAL_HARNESSES as readonly string[]).includes(profile.backend);
  const isPiHarnessProfile = profile.backend === "pi" && profile.harness !== undefined;
  if (!isExternalCli && !isPiHarnessProfile) {
    throw new Error("Profile backend must be claude, codex, agy, grok, muse, or a registered pi-* harness name.");
  }
  if (isPiHarnessProfile && !isValidHarnessName(profile.harness!)) {
    throw new Error(`Harness name must match pi-[a-z0-9][a-z0-9-]* (got ${JSON.stringify(profile.harness)}).`);
  }
  const selectorPrefix = `${profile.harness ?? profile.backend}-`;
  if (!profile.name.startsWith(selectorPrefix) || profile.name === selectorPrefix) {
    throw new Error(`Profile name must start with ${JSON.stringify(selectorPrefix)}.`);
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
    ...(profile.harness ? [`harness: ${JSON.stringify(profile.harness)}`] : []),
    ...(profile.model ? [`model: ${JSON.stringify(profile.model)}`] : []),
    ...(profile.thinking ? [`thinking: ${JSON.stringify(profile.thinking)}`] : []),
    ...(profile.tools && profile.tools.length ? [`tools: ${profile.tools.join(", ")}`] : []),
    ...(typeof profile.maxBudgetUsd === "number" ? [`max_budget_usd: ${profile.maxBudgetUsd}`] : []),
    ...(profile.owner ? [`owner: ${JSON.stringify(profile.owner)}`] : []),
  ];
  return `---\n${frontmatter.join("\n")}\n---\n\n${profile.systemPrompt.trim()}\n`;
}

/**
 * Offline install of a shared role: validate, confirm upstream, then write
 * pi-flow-external/roles/<name>.md exactly once. No backend smoke test — a
 * role is authored content, not an authenticated connection.
 */
export async function installSharedRole({
  agentDir,
  role,
  signal,
}: {
  agentDir: string;
  role: SharedRole;
  signal?: AbortSignal;
}): Promise<string> {
  const content = compileSharedRole(role);
  const dir = rolesDir(agentDir);
  const finalPath = sharedRolePath(agentDir, role.name);
  const stagedPath = join(dir, `.${role.name}.${process.pid}.${randomUUID()}.staged`);
  let finalCreated = false;
  await mkdir(dir, { recursive: true });
  try {
    await access(finalPath);
    throw new Error(`Role "${role.name}" already exists.`);
  } catch (error) {
    if (error instanceof Error && !((error as NodeJS.ErrnoException).code === "ENOENT")) {
      throw error;
    }
  }
  signal?.throwIfAborted();
  try {
    await writeFile(stagedPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    signal?.throwIfAborted();
    // Atomic no-overwrite publication: readers never observe a partial role.
    await link(stagedPath, finalPath);
    finalCreated = true;
    await unlink(stagedPath);
    signal?.throwIfAborted();
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
  return `This is a harness readiness smoke test. Do not inspect, create, modify, or delete files. Reply with exactly ${SMOKE_TOKEN} and nothing else.`;
}

function resultText(result: Awaited<ReturnType<typeof spawnSubagent>>): string | undefined {
  const details = result.details as { result?: string };
  return details.result;
}

function roleReview(role: SharedRole, path: string): string {
  return `Destination: ${path}\nShared role (works with any harness; no backend/model/thinking pin).\n\n${compileSharedRole(role)}\nRole creation is offline: no backend smoke test runs for shared roles.`;
}

function harnessReview(name: string, model: string, thinking: string, preset: PiResourcePreset): string {
  const resources = preset === "skills"
    ? "Preset: skills. The smoke test loads installed skills."
    : "Preset: minimal. The smoke test loads no skills.";
  return `Name: ${name}\nModel: ${model}\nThinking: ${thinking}\n${resources}\n\nThe six canonical roles (explorer, planner, implementer, reviewer, qa, worker) become automatically available on this harness once registered. The smoke test launches an in-process pi child pinned to this model from an empty temporary working directory.`;
}

// Each interview activates only its own finalizer: the role interview exposes
// pi_flow_role_create, the harness interview pi_flow_harness_create.
// Finalizing either tool, or a session start, deactivates both.
function setCreatorActive(pi: ExtensionAPI, tool: typeof ROLE_TOOL_NAME | typeof HARNESS_TOOL_NAME | null): void {
  const current = pi.getActiveTools().filter((name) => name !== ROLE_TOOL_NAME && name !== HARNESS_TOOL_NAME);
  pi.setActiveTools(tool ? [...current, tool] : current);
}

export function registerProfileCreator(pi: ExtensionAPI, options: ProfileCreatorOptions): void {
  const roleTool = defineTool({
    name: ROLE_TOOL_NAME,
    label: "Create pi-flow role",
    description: "Finalize a shared role during the /external role create interview. Shows the compiled role for user confirmation and writes it offline to pi-flow-external/roles/ without a backend smoke test.",
    parameters: roleParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      void toolCallId;
      let role: SharedRole;
      try {
        role = normalizeSharedRole(params);
        compileSharedRole(role);
      } catch (error) {
        return textResult(`Role validation failed: ${error instanceof Error ? error.message : String(error)}`, {
          description: "Create pi-flow role",
          subagentType: params?.name?.trim() || "unknown",

          status: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const finalPath = sharedRolePath(getAgentDir(), role.name);

      if (!ctx.hasUI) {
        return textResult("Role creation requires interactive or RPC UI so the file can be reviewed and confirmed.", {
          description: "Create pi-flow role",
          subagentType: role.name,

          status: "error",
          error: "Review UI unavailable",
        });
      }

      const confirmed = await ctx.ui.confirm(`Create role ${role.name}?`, roleReview(role, finalPath), { signal });
      if (!confirmed) {
        return textResult("Role creation cancelled. No role was created.", {
          description: "Create pi-flow role",
          subagentType: role.name,

          status: "aborted",
        });
      }

      try {
        signal?.throwIfAborted();
        const createdPath = await installSharedRole({ agentDir: getAgentDir(), role, signal });
        ctx.ui.notify(`Role "${role.name}" is ready: ${createdPath}. It works with any harness from the next invocation.`, "info");
        return textResult(`Role "${role.name}" was installed at ${createdPath}.`, {
          description: "Create pi-flow role",
          subagentType: role.name,

          status: "done",
          result: createdPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        if (cancelled) {
          ctx.ui.notify("Role creation cancelled. No role was created.", "info");
          return textResult("Role creation cancelled. No role was created.", {
            description: "Create pi-flow role",
            subagentType: role.name,

            status: "aborted",
            error: message,
          });
        }
        const existing = message === `Role "${role.name}" already exists.`;
        ctx.ui.notify(
          existing
            ? `Role creation failed: ${message} The existing role was not changed.`
            : `Role creation failed: ${message}`,
          "error",
        );
        return textResult(
          existing
            ? `Role creation failed: ${message}\n\nThe existing role was not changed.`
            : `Role creation failed: ${message}\n\nNo role was created.`, {
          description: "Create pi-flow role",
          subagentType: role.name,

          status: "error",
          error: message,
        });
      }
    },
  });
  const executeRoleCreator = roleTool.execute.bind(roleTool);
  pi.registerTool({
    ...roleTool,
    async execute(...args) {
      try {
        return await executeRoleCreator(...args);
      } finally {
        setCreatorActive(pi, null);
      }
    },
  });

  const harnessTool = defineTool({
    name: HARNESS_TOOL_NAME,
    label: "Create named Pi harness",
    description: "Finalize a new named Pi harness configuration during the /external config harness create interview. Shows what will be registered for confirmation, smoke-tests the real pi runtime against the pinned model, and rolls back on failure.",
    parameters: harnessParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const name = params.name.trim();
      const model = params.model.trim();
      const thinking = optional(params.thinking) ?? "off";
      const requestedPreset = (params as { preset?: unknown }).preset;
      const preset = requestedPreset === undefined ? "minimal" : requestedPreset;
      if (!isValidHarnessName(name)) {
        const error = `Harness name must match pi-[a-z0-9][a-z0-9-]* (got ${JSON.stringify(name)}).`;
        return textResult(error, { description: "Create Pi harness", subagentType: name || "unknown", backend: "pi", status: "error", error });
      }
      if (!isValidThinkingLevel(thinking)) {
        const error = `Unsupported thinking level ${JSON.stringify(thinking)}; expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`;
        return textResult(error, { description: "Create Pi harness", subagentType: name, backend: "pi", status: "error", error });
      }
      if (!isPiResourcePreset(preset)) {
        const error = `Unsupported Pi resource preset ${JSON.stringify(preset)}; expected one of: ${PI_RESOURCE_PRESETS.join(", ")}.`;
        return textResult(error, { description: "Create Pi harness", subagentType: name, backend: "pi", status: "error", error });
      }
      const separator = model.indexOf("/");
      const resolvedModel = separator === -1 ? undefined : ctx.modelRegistry.find(model.slice(0, separator), model.slice(separator + 1));
      if (!resolvedModel) {
        const error = `Model "${model}" was not found in the registry (expected "<provider>/<id>").`;
        return textResult(error, { description: "Create Pi harness", subagentType: name, backend: "pi", status: "error", error });
      }

      if (!ctx.hasUI) {
        return textResult("Harness creation requires interactive or RPC UI so the configuration can be reviewed and confirmed.", {
          description: "Create Pi harness",
          subagentType: name,
          backend: "pi",
          status: "error",
          error: "Review UI unavailable",
        });
      }
      const confirmed = await ctx.ui.confirm(`Register ${name}?`, harnessReview(name, model, thinking, preset), { signal });
      if (!confirmed) {
        return textResult("Harness creation cancelled. No harness was registered.", {
          description: "Create Pi harness",
          subagentType: name,
          backend: "pi",
          status: "aborted",
        });
      }

      try {
        const createdPath = await installHarnessConfigWithSmokeTest({
          agentDir: getAgentDir(),
          name,
          model,
          thinking,
          preset,
          owner: "user",
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
              smokeDir = await mkdtemp(join(tmpdir(), "pi-flow-harness-smoke-"));
              const result = await spawnSubagent({
                toolCallId: `${toolCallId}-smoke`,
                description: "Harness smoke test",
                prompt: smokePrompt(),
                profile: { name: `${name}-smoke`, description: "Harness smoke test", backend: "pi", harness: name, model, thinking, preset },
                model: resolvedModel,
                thinkingLevel: thinking,
                ctx: { ...ctx, cwd: smokeDir },
                signal,
                timeoutMs: options.getSubagentTimeoutMs(),
                progressEnabled: false,
                onProgress: undefined,
                onUsage: (usage) => options.updateStatus(ctx, toolCallId, usage),
                excludeTools: CHILD_EXCLUDED_TOOLS,
                recordRun: false,
              });
              const details = result.details as { status?: string; error?: string };
              if (details.status === "aborted") {
                throw new DOMException(details.error ?? "Harness smoke test cancelled.", "AbortError");
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
        ctx.ui.notify(`Harness "${name}" is ready: ${createdPath}`, "info");
        return textResult(`Harness "${name}" passed its smoke test and was registered at ${createdPath}.`, {
          description: "Create Pi harness",
          subagentType: name,
          backend: "pi",
          status: "done",
          result: createdPath,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = error instanceof DOMException && error.name === "AbortError";
        if (cancelled) {
          ctx.ui.notify("Harness creation cancelled. No harness was registered.", "info");
          return textResult("Harness creation cancelled. No harness was registered.", {
            description: "Create Pi harness",
            subagentType: name,
            backend: "pi",
            status: "aborted",
            error: message,
          });
        }
        ctx.ui.notify(`Harness creation failed and was rolled back: ${message}`, "error");
        return textResult(`Harness creation failed during validation or smoke testing: ${message}\n\nRolled back. No harness was registered.`, {
          description: "Create Pi harness",
          subagentType: name,
          backend: "pi",
          status: "error",
          error: message,
        });
      }
    },
  });
  const executeHarnessCreator = harnessTool.execute.bind(harnessTool);
  pi.registerTool({
    ...harnessTool,
    async execute(...args) {
      try {
        return await executeHarnessCreator(...args);
      } finally {
        setCreatorActive(pi, null);
      }
    },
  });

  pi.on("session_start", () => setCreatorActive(pi, null));
  pi.on("input", (event) => {
    if (event.source === "extension" && event.text === ROLE_INTERVIEW_PROMPT) {
      setCreatorActive(pi, ROLE_TOOL_NAME);
    } else if (event.source === "extension" && event.text === HARNESS_INTERVIEW_PROMPT) {
      setCreatorActive(pi, HARNESS_TOOL_NAME);
    }
  });
}

async function startInterview(ctx: ExtensionCommandContext, prompt: string, label: string): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify(`${label} requires interactive or RPC mode.`, "error");
    return;
  }
  if (!ctx.model) {
    ctx.ui.notify(`Select a Pi model before starting the ${label.toLowerCase()}.`, "error");
    return;
  }

  const result = await ctx.newSession({
    parentSession: ctx.sessionManager.getSessionFile(),
    withSession: async (newCtx) => {
      await newCtx.sendUserMessage(prompt);
    },
  });
  if (result.cancelled) ctx.ui.notify(`${label} cancelled.`, "info");
}

export async function startRoleInterview(ctx: ExtensionCommandContext): Promise<void> {
  await startInterview(ctx, ROLE_INTERVIEW_PROMPT, "Role interview");
}

export async function startHarnessInterview(ctx: ExtensionCommandContext): Promise<void> {
  await startInterview(ctx, HARNESS_INTERVIEW_PROMPT, "Harness interview");
}
