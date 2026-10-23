# gApp

Electron + SolidJS (StyleX) desktop app; Bun server written with Effect v4 (SQLite; Claude Code, Codex, OpenCode as agents). See README.md for architecture.

- Bun everywhere: `bun install`, `bun run <script>`. Never add an API-key auth path; agents run on the user's own logins.
- Verify changes with `bun run check` (typecheck, unit tests, build, e2e). For UI work, look at the screenshots in `test-results/`. `bun run e2e --agent` exercises a real agent run (uses the user's plan; it picks Haiku/low effort).
- `scripts/lib/cdp.ts` is a small DevTools client for driving the running app if you need to inspect something e2e doesn't cover.
- StyleX: no `border`/`background` shorthands (silently dropped) — use longhands. Keep conditions inside `stylex.attrs(...)` to a single `fn() && styles.x`; `a || b`, local booleans etc. make the compiler fail with "Referenced constant is not defined" — wrap them in a `const fn = () => …` helper. Dynamic styles (`x: (v) => ({ prop: v })`) only work for single-word properties: `stylex.attrs` kebab-cases the generated custom property name (`--x-gridTemplateColumns` → `--x-grid-template-columns`) so it no longer matches the CSS. For multi-word properties use Solid's `style={{ "grid-template-columns": … }}` after the attrs spread.
- Never open windows on the user's screen while testing: e2e runs Electron with `--ozone-platform=headless` (offscreen rendering). Don't use `bun run start`/`dev` or `--visible` for checks.
- Server code is Effect v4 (`effect@4`, `effect/http`, `effect/sql`): services are `Context.Service` + `Layer`, wired in `src/server/services.ts`. v4 names differ from v3 (e.g. `Effect.catch`, `Effect.forkDetach`, `Schema.optionalKey`); check `node_modules/effect` when unsure.
- Presets live in `src/server/workspace/presets.ts` with their files in `templates/` (`*.tpl`, imported as text so they're bundled into the compiled server). gApp's agent tools are in `src/server/agent/tools.ts` (served over MCP; input schemas must be object schemas).
