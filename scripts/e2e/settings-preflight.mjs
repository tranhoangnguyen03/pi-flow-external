import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function settingsPathFor(agentDir) {
  return path.join(agentDir, "pi-flow-external", "settings.json");
}

/**
 * Read settings without writing. Version 1–3 and a leftover harnesses.json
 * are an actionable conversion, never something this script rewrites.
 */
export function readSettingsFile(agentDir) {
  const settingsPath = settingsPathFor(agentDir);
  const legacyHarnessesPath = path.join(agentDir, "pi-flow-external", "harnesses.json");
  if (!existsSync(settingsPath)) {
    if (existsSync(legacyHarnessesPath)) {
      throw new Error(`Legacy configuration found at ${legacyHarnessesPath}. Run /external config convert to upgrade it to settings.json version 5. This script will not modify ${agentDir}.`);
    }
    return { settingsPath, missing: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (error) {
    throw new Error(`${settingsPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} must be a JSON object. This script will not modify it.`);
  }
  // Conversion is the user's explicit, reviewed action; this script never converts a real installation.
  if (parsed.version !== 5) {
    throw new Error(`Settings at ${settingsPath} are version ${JSON.stringify(parsed.version)}, not 5. Run /external config convert to upgrade this installation. This script will not modify it.`);
  }
  return { settingsPath, missing: false, parsed };
}

/**
 * Doctor-style precheck: confirm the named pi harness is registered in the
 * real settings.json version 5 harnesses map before spending time on the
 * real backend call. Model shape and presence only; live provider auth is
 * not verified here. A version 1–4 file is reported for conversion and is
 * never rewritten.
 */
export function preflightPiHarness(agentDir, harnessName) {
  const loaded = readSettingsFile(agentDir);
  if (loaded.missing) {
    throw new Error(`No settings.json found at ${loaded.settingsPath}. Register "${harnessName}" under "harnesses" in settings.json version 5. This script will not create or modify it.`);
  }
  const harnesses = loaded.parsed.harnesses;
  const registry = harnesses && typeof harnesses === "object" && !Array.isArray(harnesses) ? harnesses : undefined;
  const entry = registry ? registry[harnessName] : undefined;
  if (!entry || typeof entry.model !== "string" || !entry.model.trim()) {
    const registered = registry ? Object.keys(registry) : [];
    throw new Error(
      `Harness "${harnessName}" is not registered in ${loaded.settingsPath}. ` +
      `Registered harnesses: ${registered.join(", ") || "none"}.`,
    );
  }
}

