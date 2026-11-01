// Shared precheck for field-test CLI runs. Reads real settings but never writes them.
// Independent of model SDK initialization and process launch.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function settingsPathFor(agentDir) {
  return path.join(agentDir, "pi-flow-external", "settings.json");
}

/**
 * Read settings without writing. Version 4 needs /external config convert;
 * pre-v4 files (or a leftover harnesses.json) need the last converting release.
 */
export function readSettingsFile(agentDir) {
  const settingsPath = settingsPathFor(agentDir);
  const legacyHarnessesPath = path.join(agentDir, "pi-flow-external", "harnesses.json");
  if (!existsSync(settingsPath)) {
    if (existsSync(legacyHarnessesPath)) {
      throw new Error(`Pre-v4 configuration found at ${legacyHarnessesPath}. Convert it with @tranhoangnguyen0310/pi-flow-external@5.5.0-external.2 first. This script will not modify ${agentDir}.`);
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
    const how = [1, 2, 3].includes(parsed.version) ? "Convert them with @tranhoangnguyen0310/pi-flow-external@5.5.0-external.2 first" : "Run /external config convert to upgrade this installation";
    throw new Error(`Settings at ${settingsPath} are version ${JSON.stringify(parsed.version)}, not 5. ${how}. This script will not modify it.`);
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

