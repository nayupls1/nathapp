/**
 * Environment for the Claude Code process. API keys are removed so it always
 * uses the logged-in Claude account, and variables leaked from a parent Claude
 * Code session (e.g. when gApp is started from one) are dropped.
 */
export function agentEnv() {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "ANTHROPIC_API_KEY" || key === "ANTHROPIC_AUTH_TOKEN" || key === "CLAUDECODE") delete env[key];
    if (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN") delete env[key];
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "gapp/0.1.0";
  return env;
}
