import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Where all persistent state lives. Electron passes its userData dir. */
export const dataDir = resolve(process.env.GAPP_DATA_DIR ?? ".data");
export const appsDir = join(dataDir, "apps");
/** Empty working directory for agent sessions, so they never touch real files. */
export const agentDir = join(dataDir, "agent");

for (const dir of [dataDir, appsDir, agentDir]) mkdirSync(dir, { recursive: true });

/**
 * Path to the Claude Code binary the Agent SDK should run. From source the SDK
 * resolves its own bundled binary; inside a `bun build --compile` executable it
 * can't, so the build ships the binary next to the server executable.
 */
export function claudeExecutable(): string | undefined {
  if (process.env.GAPP_CLAUDE_PATH) return process.env.GAPP_CLAUDE_PATH;
  const compiled = import.meta.path.includes("$bunfs") || import.meta.path.includes("~BUN");
  if (!compiled) return undefined;
  return join(dirname(process.execPath), process.platform === "win32" ? "claude.exe" : "claude");
}
