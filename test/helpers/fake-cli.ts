import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Install a fake backend executable and put it ahead of the real CLI in PATH. */
export function installFakeCli(directory: string, executable: string, source: string, previousPath?: string): void {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, executable);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  process.env.PATH = `${directory}:${previousPath ?? ""}`;
}
