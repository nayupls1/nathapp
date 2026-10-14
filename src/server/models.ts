// Models available to the user's Claude account, as reported by Claude Code.
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { ModelOption } from "../shared/api";
import { agentDir, claudeExecutable } from "./config";
import { agentEnv } from "./env";

let cached: Promise<ModelOption[]> | undefined;

export function listModels(): Promise<ModelOption[]> {
  cached ??= load().catch((err) => {
    cached = undefined; // retry on the next request
    throw err;
  });
  return cached;
}

async function load(): Promise<ModelOption[]> {
  // A session that never receives a prompt: only used to ask for the model list.
  const idle = (async function* () {
    await new Promise(() => {});
  })();
  const session = query({
    prompt: idle as AsyncIterable<never>,
    options: {
      tools: [],
      settingSources: [],
      cwd: agentDir,
      env: agentEnv(),
      persistSession: false,
      pathToClaudeCodeExecutable: claudeExecutable(),
    },
  });
  try {
    const models = await session.supportedModels();
    return models.map((m) => ({
      value: m.value,
      displayName: m.displayName,
      description: m.description,
      efforts: m.supportedEffortLevels ?? [],
    }));
  } finally {
    session.close();
  }
}
