# gApp

Electron + SolidJS (StyleX) desktop app; Bun server (SQLite, Claude Agent SDK). See README.md for architecture.

- Bun everywhere: `bun install`, `bun run <script>`. Never add an API-key auth path; the agent runs on the user's Claude login.
- Verify changes with `bun run check` (typecheck, unit tests, build, e2e). For UI work, look at the screenshots in `test-results/`. `bun run e2e --agent` exercises a real agent run (uses the user's plan; it picks Haiku/low effort).
- `scripts/lib/cdp.ts` is a small DevTools client for driving the running app if you need to inspect something e2e doesn't cover.
- StyleX: no `border`/`background` shorthands (silently dropped) — use longhands. Keep conditions inside `stylex.attrs(...)` to a single `fn() && styles.x`; `a || b`, local booleans etc. make the compiler fail with "Referenced constant is not defined" — wrap them in a `const fn = () => …` helper. Dynamic styles (`x: (v) => ({ prop: v })`) only work for single-word properties: `stylex.attrs` kebab-cases the generated custom property name (`--x-gridTemplateColumns` → `--x-grid-template-columns`) so it no longer matches the CSS. For multi-word properties use Solid's `style={{ "grid-template-columns": … }}` after the attrs spread.
- The catalog contract lives in `src/shared/spec.ts` + `src/shared/catalog.ts`; the agent prompt is generated from the catalog.
