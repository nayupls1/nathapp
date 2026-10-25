// Outside of Electron, the `electron` package exports the path to its binary.
import electronBinary from "electron";

// Bundles the Electron main + preload scripts (the window's, and the one of web
// tab sessions for extensions) with Bun. Electron ships its own
// Node runtime, so these target Node and are emitted as CommonJS (sandboxed
// preload scripts must be CJS).
export async function buildElectron({ dev = false } = {}) {
  const result = await Bun.build({
    entrypoints: ["src/main/index.ts", "src/preload/index.ts", "src/extension-preload/index.ts"],
    outdir: "dist/electron",
    root: "src",
    target: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: dev ? "inline" : "none",
    minify: !dev,
    naming: "[dir].cjs",
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error("Electron build failed");
  }
}

/** Launches the Electron app in the current directory. */
export function launchElectron(env: Record<string, string | undefined> = {}, args: string[] = []) {
  const childEnv = { ...process.env, ...env };
  // Set by Electron-based hosts (VS Code, T3 Code, …) for their child processes;
  // if inherited, Electron would boot as plain Node and the app would crash.
  delete childEnv.ELECTRON_RUN_AS_NODE;

  return Bun.spawn([electronBinary as unknown as string, ".", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: childEnv,
  });
}
