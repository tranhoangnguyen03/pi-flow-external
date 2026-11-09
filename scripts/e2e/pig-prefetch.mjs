#!/usr/bin/env node
/**
 * Optional CI prefetch for an immutable PiG release asset.
 *
 * The normal PiG-Agent builder owns asset retrieval and independently verifies
 * SHA-256 against shell/source-lock.json. This fallback only warms its cache
 * via GitHub's asset API when github.com release downloads return HTTP 504.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const shell = resolve(process.argv[2] || "_pig_agent");
const lock = JSON.parse(await readFile(join(shell, "shell/source-lock.json"), "utf8"));
const target = process.platform + "-" + process.arch;
const item = lock.pig.archives[target];
if (!item) throw new Error("Unsupported PiG native target: " + target);
if (lock.pig.version !== "0.5.3") throw new Error("Prefetch is pinned to PiG 0.5.3 only");

const assetIds = {
  "pig-0.5.3-linux-amd64.tar.gz": 668083112,
  "pig-0.5.3-darwin-arm64.tar.gz": 668083077,
  "pig-0.5.3-darwin-amd64.tar.gz": 668083055,
};
const asset = assetIds[item.name];
if (!asset || !/^[0-9a-f]{64}$/.test(item.sha256)) {
  throw new Error("Release archive name or expected SHA-256 is not recognized");
}
const token = process.env.GH_TOKEN;
if (!token) {
  console.log("No GitHub token available: original pinned builder will download normally.");
  process.exit(0);
}

const cache = join(shell, "dist/shell/cache");
const file = join(cache, item.name);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
try {
  // Never overwrite an already-correct file; the builder will verify it again.
  try {
    if (sha(await readFile(file)) === item.sha256) {
      console.log("Verified cached PiG release asset: " + item.name);
      process.exit(0);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const response = await fetch(`https://api.github.com/repos/MichaelKinsy/PiG/releases/assets/${asset}`, {
    headers: {
      "Accept": "application/octet-stream",
      "Authorization": `Bearer ${token}`,
      "User-Agent": "pi-flow-external-native-qualification",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    console.log(`GitHub asset API returned ${response.status}; original release download will be attempted.`);
    process.exit(0);
  }
  const kind = response.headers.get("content-type") || "";
  if (kind.includes("json")) {
    console.log("GitHub asset API returned metadata rather than the archive; using original builder.");
    process.exit(0);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = sha(bytes);
  if (digest !== item.sha256) {
    throw new Error(`GitHub API archive SHA-256 mismatch for ${item.name}: expected ${item.sha256}, got ${digest}`);
  }
  await mkdir(cache, { recursive: true });
  const staging = file + ".prefetch-" + process.pid;
  try {
    await writeFile(staging, bytes);
    await rename(staging, file);
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
  console.log("Fetched and SHA-verified PiG asset through GitHub API: " + item.name);
} catch (error) {
  if (/SHA-256 mismatch/.test(String(error))) throw error;
  // Availability errors still surface if the original builder also fails.
  console.log("API prefetch unavailable (" + (error instanceof Error ? error.name : "unknown error") + "); original builder will try its pinned URL.");
}
