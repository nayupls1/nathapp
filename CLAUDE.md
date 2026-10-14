# gApp

Electron + SolidJS (StyleX) desktop app; Bun server (SQLite, Claude Agent SDK). See README.md for architecture.

- Bun everywhere: `bun install`, `bun run <script>`. Never add an API-key auth path; the agent runs on the user's Claude login.
- Verify changes with `bun run check` (typecheck, unit tests, build, e2e). For UI work, look at the screenshots in `test-results/`. `bun run e2e --agent` exercises a real agent run (uses the user's plan; it picks Haiku/low effort).
- `scripts/lib/cdp.ts` is a small DevTools client for driving the running app if you need to inspect something e2e doesn't cover.
- StyleX: no `border`/`background` shorthands (silently dropped) — use longhands. Don't pass local variables into `stylex.attrs` conditions; call a function instead (the compiler tries to evaluate identifiers).
- The catalog contract lives in `src/shared/spec.ts` + `src/shared/catalog.ts`; the agent prompt is generated from the catalog.
