import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const defaults = {
  claude: { model: "claude-sonnet-5", thinking: "high" },
  codex: { model: "gpt-5.6-sol", thinking: "high" },
  agy: { model: "gemini-3.7-flash-high", thinking: "high" },
  grok: { model: "grok-4.6", thinking: "high" },
  muse: { model: "muse-spark-1.3-contributor", thinking: "high" },
  // OpenCode needs no pinned model (its own configured default applies; pass
  // --model provider/model to pin one). Thinking is a model variant, so it
  // needs --model too.
  opencode: {},
  // No fixed model/thinking default: a named pi harness pins its own model and
  // thinking in the caller's real settings.json (version 5) harnesses map;
  // --harness names which one.
  pi: {},
};
const PERMISSION_TIERS = ["readonly", "edit", "danger"];
export function parseArgs(argv) {
  const options = {
    backend: "codex",
    routingSmoke: false,
    rootModel: "openai-codex/gpt-5.6-sol",
    rootThinking: "high",
    runRoot: path.join(tmpdir(), `pi-flow-external-e2e-${randomUUID()}`),
    timeoutMs: 180_000,
    workflow: false,
    interrupt: false,
    keep: false,
  };
  let rootModelProvided = false;
  let rootThinkingProvided = false;
  let agentDirProvided = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      if (argv[index + 1] === undefined) throw new Error(`${arg} requires a value`);
      return argv[++index];
    };
    if (arg === "--backend") options.backend = value();
    else if (arg === "--harness") options.harness = value();
    else if (arg === "--model") options.model = value();
    else if (arg === "--thinking") options.thinking = value();
    else if (arg === "--permission") options.permission = value();
    else if (arg === "--root-model") { options.rootModel = value(); rootModelProvided = true; }
    else if (arg === "--root-thinking") { options.rootThinking = value(); rootThinkingProvided = true; }
    else if (arg === "--agent-dir") { options.agentDir = path.resolve(value()); agentDirProvided = true; }
    else if (arg === "--run-root") options.runRoot = path.resolve(value());
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else if (arg === "--workflow") options.workflow = true;
    else if (arg === "--interrupt") options.interrupt = true;
    else if (arg === "--routing-smoke") options.routingSmoke = true;
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Object.hasOwn(defaults, options.backend)) throw new Error("--backend must be claude, codex, agy, grok, muse, opencode, or pi");
  if (options.backend === "pi" && !options.harness) throw new Error("--backend pi requires --harness <name>, a pi-* harness already registered in your own real settings.json version 5");
  if (options.backend !== "pi" && options.harness) throw new Error("--harness only applies to --backend pi");
  if (options.backend === "opencode" && options.thinking !== undefined && options.model === undefined) throw new Error("--thinking on --backend opencode names a model variant and needs --model provider/model");
  if (options.permission !== undefined && !PERMISSION_TIERS.includes(options.permission)) {
    throw new Error("--permission must be readonly, edit, or danger");
  }
  // Field runs, including Grok, request a tier on the child call. Omit the
  // flag to keep this runner's existing explicit danger tier.
  options.permission ??= "danger";
  if (options.workflow && options.interrupt) throw new Error("--workflow and --interrupt are separate checks");
  // --root-model/--root-thinking only mean anything when a real root Pi LLM is
  // actually prompted to choose the tool call, which only happens in the
  // --routing-smoke lane. The default deterministic lane below never prompts
  // a root model at all (it calls external_delegate/external_workflow/external_runs directly), so
  // accepting these flags there would silently do nothing and mislead callers
  // into thinking they changed root behavior.
  if (!options.routingSmoke && (rootModelProvided || rootThinkingProvided)) {
    throw new Error("--root-model and --root-thinking only apply to --routing-smoke");
  }
  // Only claude/codex/agy/grok/muse/opencode get an isolated, disposable agent dir by
  // default: this script writes their temporary profile file into it itself,
  // so isolation is safe and desirable. This default is unconditional — an
  // inherited PI_CODING_AGENT_DIR from the caller's shell is deliberately
  // ignored unless --agent-dir was passed explicitly, otherwise a real
  // agent dir left set in the environment (as docs/maintainer/field-testing.md itself
  // tells callers to export) would silently defeat isolation. A named pi
  // harness is the opposite case — it is never written by this script, only
  // read — so it must default to the caller's REAL Pi agent directory
  // (matching the README's own PI_CODING_AGENT_DIR:-$HOME/.pi/agent
  // convention), or every --backend pi run would silently look at an empty,
  // freshly-created isolated directory that could never contain the harness
  // the caller actually registered.
  options.agentDir ??= options.backend === "pi"
    ? (process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent"))
    : path.join(options.runRoot, "agent");
  options.agentDirProvided = agentDirProvided;
  options.model ??= defaults[options.backend].model;
  options.thinking ??= defaults[options.backend].thinking;
  return options;
}

