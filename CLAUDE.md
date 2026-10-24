# NathApp

Electron + SolidJS (StyleX) desktop app; Bun server written with Effect v4 (SQLite; Claude Code, Codex, OpenCode as agents). See README.md for architecture.

## Working with the user

- The user dictates by voice, so names arrive garbled: decode them phonetically ("Dialects" = StyleX, "Cloud Agents SDK" = Claude Agent SDK, "Cloud Sub" = Claude subscription, "Bonn" = Bun, "codecs" = Codex, "ping.gg" = pingdotgg). Ask only when it's genuinely ambiguous.
- Work on `master` (don't create or rename branches). Don't push unless asked.
- Commit on your own when a piece of work is done, without asking. Never commit anything sensitive: secrets, tokens, credentials, personal data, local databases or `.data/`. Check the staged diff before committing.
- Several Claude threads may work in this repo at the same time:
  - Commit only the files you changed (`git add <paths>`, not `git add -A`). Leave other threads' uncommitted work alone.
  - Never use broad `pkill -f` patterns. They can kill other threads' servers and e2e runs, or your own shell when the pattern matches the command itself. Stop only the processes you started (by PID, or `pkill -x <name>`).
  - Use throwaway data dirs (`NATHAPP_DATA_DIR=$(mktemp -d)`) and free ports for manual server runs, never `.data/` or a fixed port another thread might use.
- Never open windows on the user's screen. They use Hyprland/Wayland, where windows pop up on the focused workspace, right where they're working.
  - e2e runs Electron with `--ozone-platform=headless` and offscreen rendering, so nothing appears.
  - Don't use `bun run start`, `bun run dev`, `e2e --visible`, or `xdg-open`/`shell.openExternal` for checks.
- Use your own judgment for refinements and keep going until the task is complete. Report caveats honestly at the end.

## Rules for the product

- Auth is always the user's own logins (Claude subscription, Codex/ChatGPT, OpenCode). Never add an API-key path; `ANTHROPIC_API_KEY` is stripped from Claude's environment on purpose.
- Don't show the user's account email anywhere in the UI. The plan type ("Claude Pro") is fine.
- Secret values never reach agents, prompts, logs, process arguments or the API's responses (see README: Secrets). Agent processes get the environment via `agentEnv()` (no `NATHAPP_*`); app processes get exactly what the Runtime/Sandbox give them.
- New capabilities that let an app or agent reach beyond its sandbox go through `Permissions.ask` and are recorded with `Audit.record`.
- Untrusted input never reaches a provider that has tools of its own. This covers web pages (the website agent) and apps' AI requests: they run with `access: "none"`, where every provider has its file, shell, web and connector tools switched off.

## Development

- Bun everywhere: `bun install`, `bun run <script>`.
- Verify changes with `bun run check` (typecheck, unit tests, build, e2e). Chain steps with `&&`, and don't hide failures behind pipes.
  - For UI work, look at the screenshots in `test-results/`.
  - `bun run e2e --agent` exercises real agent runs. They use the user's plan; it picks Haiku/low effort.
- `scripts/lib/cdp.ts` is a small DevTools client for driving the running app if you need to inspect something e2e doesn't cover. Launch it headless as above.
- StyleX:
  - No `border`/`background` shorthands: they're silently dropped. Use longhands.
  - Keep conditions inside `stylex.attrs(...)` to a single `fn() && styles.x`. Comparisons, `a || b`, `!x`, local booleans etc. make the compiler fail with "Referenced constant is not defined"; wrap them in a `const fn = () => …` helper.
  - Dynamic styles (`x: (v) => ({ prop: v })`) only work for single-word properties. `stylex.attrs` kebab-cases the generated custom property name (`--x-gridTemplateColumns` → `--x-grid-template-columns`), so it no longer matches the CSS. For multi-word properties use Solid's `style={{ "grid-template-columns": … }}` after the attrs spread.
  - Portaled elements (popovers, menus) need their own `fontFamily`.
- Server code is Effect v4 (`effect@4`, `effect/http`, `effect/sql`):
  - Services are `Context.Service` + `Layer`, wired in `src/server/services.ts`.
  - v4 names differ from v3 (e.g. `Effect.catch`, `Effect.forkDetach`, `Schema.optionalKey`); check `node_modules/effect` when unsure.
- Naming: a *workspace* (`db/Workspaces.ts`, `WorkspaceInfo`) groups tabs; `workspace/Workspace.ts` is an app's project folder. New per-tab features should consider which workspace they belong to (secrets, permissions and the audit log are scoped by it).
- Presets live in `src/server/workspace/presets.ts`, with their files in `templates/` (`*.tpl`, imported as text so they're bundled into the compiled server).
- NathApp's agent tools are in `src/server/agent/tools.ts`. They're served over MCP, and their input schemas must be object schemas: one bad schema makes clients drop every tool.
