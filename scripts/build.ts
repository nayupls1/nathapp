// Production build:
//   dist/renderer  – SolidJS app (Vite)
//   dist/electron  – Electron main + preload (Bun bundler)
//   dist/server    – Bun server compiled to a standalone executable, plus the
//                    Claude Code binary the Agent SDK drives
import { chmod, copyFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { build as viteBuild } from "vite";
import { buildElectron } from "./electron";

const exe = process.platform === "win32" ? ".exe" : "";
const serverBinary = `gapp-server${exe}`;

await rm("dist", { recursive: true, force: true });

console.log("› renderer");
await viteBuild({ configFile: "vite.config.ts", logLevel: "warn" });

console.log("› electron");
await buildElectron();

console.log("› server");
await Bun.$`bun build --compile --minify --sourcemap src/server/index.ts --outfile dist/server/${serverBinary}`.quiet();

// The compiled server can't resolve the SDK's platform package at runtime, so
// ship the binary next to it (see claudeExecutable() in src/server/config.ts).
console.log("› claude binary");
const sdkPlatformPackage = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
const claudeBinary = createRequire(import.meta.url).resolve(`${sdkPlatformPackage}/claude${exe}`);
await copyFile(claudeBinary, `dist/server/claude${exe}`);
await chmod(`dist/server/claude${exe}`, 0o755);

console.log("✓ build complete — run `bun run start` to launch");
