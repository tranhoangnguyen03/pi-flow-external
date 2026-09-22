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
import {
  extractSharedPiRoleProfiles,
  filterExternalAgentProfiles,
  getSubagentProfiles,
  isSharedPiRoleTemplate,
  isValidSubagentName,
  materializeSharedPiRoleProfile,
  parseSubagentProfileContent,
  reconcilePiProfileWithHarness,
  SHARED_PI_HARNESS_MARKER,
  sharedPiRoleName,
} from "./profiles.ts";
import {
  getConfiguredHarnessNames,
  installHarnessConfigWithSmokeTest,
  isValidHarnessName,
  isValidThinkingLevel,
  loadHarnessConfigs,
  VALID_THINKING_LEVELS,
  type HarnessConfig,
} from "./harnesses.ts";
import { EXTERNAL_HARNESSES } from "./types.ts";
import type { SubagentProfile, SubagentUsage } from "./types.ts";

const PROFILE_TOOL_NAME = "pi_flow_profile_create";
const HARNESS_TOOL_NAME = "pi_flow_harness_create";
const SMOKE_TOKEN = "PI_FLOW_PROFILE_OK";

export const PROFILE_INTERVIEW_PROMPT = `Help me create one pi-flow external agent profile, or one named Pi harness configuration, through an AI-assisted interview.

Start by asking which of four things I want:
1. A role profile for an existing external CLI harness (claude, codex, agy, grok, or muse).
2. A new named Pi harness configuration (a "pi-*" name pinning a provider/model and optional thinking level, run in-process rather than as a CLI).
3. A role profile for one existing registered pi-* harness only.
4. A shared role profile applied across every currently-registered pi-* harness, and any registered later.

For branch 1 or 3: ask one question at a time, only when the answer is not already known. Collect enough information to write a focused profile: its intended work, boundaries (especially read-only versus file modification), useful output, validation expectations, and stop/escalation rules. For branch 1, recommend a backend (claude, codex, agy, grok, or muse) and explain briefly; for branch 3, confirm which already-registered pi-* harness this role targets. Suggest a lowercase <harness>-<role> profile name; the suffix becomes the role callers use. Ask about model and thinking only when I want to pin them for branch 1/3 profiles; otherwise omit them — for branch 3, model/thinking are inherited from the named harness and must not be overridden to a different value. When ready, summarize once and call ${PROFILE_TOOL_NAME}.

For branch 2: ask for a "pi-<label>" name, a provider/model id (validated live against the model registry), and an optional thinking level (off/minimal/low/medium/high/xhigh; default off). The six canonical roles (explorer, planner, implementer, reviewer, qa, worker) become automatically available on this harness the moment it is registered — no per-role file needed. When ready, summarize once and call ${HARNESS_TOOL_NAME}.

For branch 4: collect the same focused-profile information as branch 1/3, but never ask about model or thinking — a shared role must not pin either, since it materializes onto whichever harness runs it using that harness's own registered model/thinking. Suggest a lowercase "pi-<role>" profile name (no harness prefix) and pass backend "${SHARED_PI_HARNESS_MARKER}" when calling ${PROFILE_TOOL_NAME}. Explain that a harness-specific <harness>-<role> file, if one already exists, still takes precedence over this shared role for that one harness. This branch requires at least one already-registered pi-* harness to smoke-test against; if none exists, tell me to register one first (branch 2).

Do not write files yourself and do not run Agent or workflow in any branch. The tool will show what will be created for review, request confirmation, stage it, run a real backend smoke test, and either install it or roll it back.`;

const profileParameters = Type.Object({
  name: Type.String({ description: "Lowercase <harness>-<role> profile name, such as claude-security-reviewer or pi-deepseek-security-reviewer; the suffix becomes its role." }),
  description: Type.String({ description: "Concise profile description shown by external_help and in delegation intent." }),
  backend: Type.String({ description: `External CLI backend (claude, codex, agy, grok, muse), a registered named pi-* harness, or the literal "${SHARED_PI_HARNESS_MARKER}" marker for a role shared across every registered pi-* harness.` }),
  model: Type.Optional(Type.String({ description: `Optional backend model override. Omit to use the CLI default. For a pi-* backend, must match the harness's registered model if given at all. Must be omitted entirely for backend "${SHARED_PI_HARNESS_MARKER}".` })),
  thinking: Type.Optional(Type.String({ description: `Optional reasoning-effort override. Omit to use the current Pi level. For a pi-* backend, must match the harness's registered thinking if given at all. Must be omitted entirely for backend "${SHARED_PI_HARNESS_MARKER}".` })),
  systemPrompt: Type.String({ description: "Complete focused instructions for the external agent profile." }),
});

type ProfileParameters = Static<typeof profileParameters>;

const harnessParameters = Type.Object({
  name: Type.String({ description: "Lowercase pi-<label> harness name, such as pi-deepseek." }),
  model: Type.String({ description: "provider/modelId, resolved live against the Pi model registry, such as deepseek/deepseek-chat." }),
  thinking: Type.Optional(Type.String({ description: "Optional thinking level: off, minimal, low, medium, high, or xhigh. Defaults to off." })),
});

type HarnessParameters = Static<typeof harnessParameters>;

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

/** Is `backend` one of claude/codex/agy/grok/muse (a genuine external CLI selector)? */
function isExternalHarnessBackend(value: string): value is (typeof EXTERNAL_HARNESSES)[number] {
  return (EXTERNAL_HARNESSES as readonly string[]).includes(value);
}

function normalizeProfile(input: ProfileParameters): SubagentProfile {
  const backendInput = input.backend.trim();
  const isPiHarness = !isExternalHarnessBackend(backendInput);
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    backend: isPiHarness ? "pi" : backendInput,
    ...(isPiHarness ? { harness: backendInput } : {}),
    model: optional(input.model),
    thinking: optional(input.thinking),
    systemPrompt: input.systemPrompt.trim(),
    // Profiles authored through this flow belong to the user.
    owner: "user",
  };
}

export function compileProfile(profile: SubagentProfile): string {
  if (!isValidSubagentName(profile.name)) {
    throw new Error("Profile name must contain only lowercase letters, numbers, and hyphens.");
  }
  const isExternalCli = (EXTERNAL_HARNESSES as readonly string[]).includes(profile.backend);
  const isSharedTemplate = isSharedPiRoleTemplate(profile);
  const isPiHarnessProfile = profile.backend === "pi" && profile.harness !== undefined && !isSharedTemplate;
  if (!isExternalCli && !isPiHarnessProfile && !isSharedTemplate) {
    throw new Error(`Profile backend must be claude, codex, agy, grok, muse, a registered pi-* harness name, or the shared "${SHARED_PI_HARNESS_MARKER}" marker.`);
  }
  if (isPiHarnessProfile && !isValidHarnessName(profile.harness!)) {
    throw new Error(`Harness name must match pi-[a-z0-9][a-z0-9-]* (got ${JSON.stringify(profile.harness)}).`);
  }
  if (isSharedTemplate && (profile.model !== undefined || profile.thinking !== undefined)) {
    throw new Error(`Shared role profile "${profile.name}" must not pin model or thinking; each registered pi-* harness supplies its own. Remove the override(s).`);
  }
  if (profile.capabilitySet && isExternalCli) {
    throw new Error(`Profile "${profile.name}" declares backend "${profile.backend}" and capabilitySet "${profile.capabilitySet}", but capabilitySet only applies to backend "pi" (in-process, curated-tools) profiles — the ${profile.backend} CLI has no mechanism to load skills/prompt templates and would silently ignore the selection. Remove capabilitySet from this profile or change its backend to "pi" with a registered harness.`);
  }
  const selectorPrefix = isSharedTemplate ? "pi-" : `${profile.harness ?? profile.backend}-`;
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
    ...(profile.permission ? [`permission: ${JSON.stringify(profile.permission)}`] : []),
    ...(profile.owner ? [`owner: ${JSON.stringify(profile.owner)}`] : []),
    ...(profile.capabilitySet ? [`capabilitySet: ${JSON.stringify(profile.capabilitySet)}`] : []),
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
  smokeTest: (reconciledProfile: SubagentProfile) => Promise<{ ok: true } | { ok: false; error: string }>;
}): Promise<string> {
  const { harnesses: harnessConfigs } = loadHarnessConfigs(agentDir);
  // A shared role template has no single harness to reconcile against; its
  // model/thinking rejection is enforced by compileProfile instead.
  const reconciled = isSharedPiRoleTemplate(profile) ? profile : reconcilePiProfileWithHarness(profile, harnessConfigs);
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
    const smoke = await smokeTest(reconciled);
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

    // A shared role template is never externally selectable on its own (see
    // isExternalAgentProfile), so its discovery check reads back the raw
    // template instead of the filtered/selectable roster.
    const installedProfiles = getSubagentProfiles(agentDir);
    const installed = isSharedPiRoleTemplate(profile)
      ? extractSharedPiRoleProfiles(installedProfiles).templates.get(sharedPiRoleName(profile.name) ?? "")
      : filterExternalAgentProfiles(installedProfiles, getConfiguredHarnessNames(agentDir)).get(profile.name);
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

function profileReview(profile: SubagentProfile, path: string, smokeHarness?: string): string {
  const sharedNote = smokeHarness
    ? `\nThis role applies to every registered pi-* harness (currently: ${smokeHarness} and any others) that lacks its own <harness>-${sharedPiRoleName(profile.name)} override; the smoke test below only exercises "${smokeHarness}" as a representative.\n`
    : "";
  return `Destination: ${path}\nBackend executable: ${profile.backend}\n${sharedNote}\n${compileProfile(profile)}\nThe smoke test omits these profile instructions and launches this backend in its configured no-approval mode from an empty temporary working directory.`;
}

function harnessReview(name: string, model: string, thinking: string): string {
  return `Name: ${name}\nModel: ${model}\nThinking: ${thinking}\n\nThe six canonical roles (explorer, planner, implementer, reviewer, qa, worker) become automatically available on this harness once registered. The smoke test launches an in-process pi child pinned to this model from an empty temporary working directory.`;
}

// Both creator tools are activated together during the interview: the
// assistant picks whichever branch (role profile vs. new harness) applies and
// calls that one tool; finalizing either one deactivates both.
function setProfileCreatorActive(pi: ExtensionAPI, active: boolean): void {
  const current = pi.getActiveTools().filter((name) => name !== PROFILE_TOOL_NAME && name !== HARNESS_TOOL_NAME);
  pi.setActiveTools(active ? [...current, PROFILE_TOOL_NAME, HARNESS_TOOL_NAME] : current);
}

export function registerProfileCreator(pi: ExtensionAPI, options: ProfileCreatorOptions): void {
  const creatorTool = defineTool({
    name: PROFILE_TOOL_NAME,
    label: "Create pi-flow profile",
    description: "Finalize a profile during the /external profile create interview. Shows the compiled profile for user confirmation, smoke-tests the real external backend, and rolls back on failure.",
    parameters: profileParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const profile = normalizeProfile(params);
      const finalPath = join(getAgentDir(), "subagents", `${profile.name}.md`);
      const { harnesses: harnessConfigs } = loadHarnessConfigs(getAgentDir());
      const isSharedTemplate = isSharedPiRoleTemplate(profile);
      let reconciled: SubagentProfile | undefined;
      let smokeHarness: string | undefined;
      let smokeHarnessConfig: HarnessConfig | undefined;
      try {
        compileProfile(profile);
        if (isSharedTemplate) {
          const first = harnessConfigs.entries().next();
          if (first.done) {
            throw new Error("Register a named Pi harness first (via /external profile create); a shared pi-* role needs at least one live harness to validate against.");
          }
          [smokeHarness, smokeHarnessConfig] = first.value;
        } else {
          reconciled = reconcilePiProfileWithHarness(profile, harnessConfigs);
        }
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
        profileReview(profile, finalPath, smokeHarness),
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
          smokeTest: async (reconciledProfile) => {
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
              const smokeProfile = isSharedTemplate
                ? materializeSharedPiRoleProfile(sharedPiRoleName(profile.name)!, smokeHarness!, smokeHarnessConfig!, profile)
                : profile.backend === "pi" ? (reconciledProfile ?? reconciled!) : profile;
              const result = await spawnSubagent({
                toolCallId: `${toolCallId}-smoke`,
                description: "Profile smoke test",
                prompt: smokePrompt(),
                // Validate backend availability/auth/model without executing the
                // new profile's instructions or loading project instructions.
                profile: { ...smokeProfile, systemPrompt: undefined },
                // The pi backend's spawn runtime requires a pre-resolved model
                // object, unlike claude/codex/agy/grok/muse which resolve their own model
                // string internally; resolve it here so the smoke test actually
                // exercises the harness's registered model instead of failing
                // immediately with "No model is selected".
                model: smokeProfile.backend === "pi" ? resolveProfileModel(smokeProfile, ctx) : undefined,
                thinkingLevel: smokeProfile.backend === "agy"
                  ? undefined
                  : smokeProfile.thinking ?? options.getThinkingLevel(),
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
  });
  const executeCreator = creatorTool.execute.bind(creatorTool);
  pi.registerTool({
    ...creatorTool,
    async execute(...args) {
      try {
        return await executeCreator(...args);
      } finally {
        setProfileCreatorActive(pi, false);
      }
    },
  });

  const harnessTool = defineTool({
    name: HARNESS_TOOL_NAME,
    label: "Create named Pi harness",
    description: "Finalize a new named Pi harness configuration during the /external profile create interview. Shows what will be registered for confirmation, smoke-tests the real pi runtime against the pinned model, and rolls back on failure.",
    parameters: harnessParameters,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const name = params.name.trim();
      const model = params.model.trim();
      const thinking = optional(params.thinking) ?? "off";
      if (!isValidHarnessName(name)) {
        const error = `Harness name must match pi-[a-z0-9][a-z0-9-]* (got ${JSON.stringify(name)}).`;
        return textResult(error, { description: "Create Pi harness", subagentType: name || "unknown", backend: "pi", status: "error", error });
      }
      if (!isValidThinkingLevel(thinking)) {
        const error = `Unsupported thinking level ${JSON.stringify(thinking)}; expected one of: ${VALID_THINKING_LEVELS.join(", ")}.`;
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
      const confirmed = await ctx.ui.confirm(`Register ${name}?`, harnessReview(name, model, thinking), { signal });
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
                profile: { name: `${name}-smoke`, description: "Harness smoke test", backend: "pi", harness: name, model, thinking },
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
        setProfileCreatorActive(pi, false);
      }
    },
  });

  pi.on("session_start", () => setProfileCreatorActive(pi, false));
  pi.on("input", (event) => {
    if (event.source === "extension" && event.text === PROFILE_INTERVIEW_PROMPT) {
      setProfileCreatorActive(pi, true);
    }
  });

  pi.registerCommand("pi-flow-profile", {
    description: "Deprecated: use /external profile create",
    getArgumentCompletions: (prefix) => "create".startsWith(prefix.trim())
      ? [{ value: "create", label: "create", description: "Start an AI-assisted profile interview" }]
      : null,
    handler: async (args, ctx) => {
      if (args.trim() !== "create") {
        ctx.ui.notify("Usage: /external profile create", "warning");
        return;
      }
      ctx.ui.notify("/pi-flow-profile is deprecated; use /external profile create.", "warning");
      await startProfileInterview(ctx);
    },
  });
}

export async function startProfileInterview(ctx: ExtensionCommandContext): Promise<void> {
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
  if (result.cancelled) ctx.ui.notify("Profile interview cancelled.", "info");
}
