# gApp

Desktop app for building small personal apps by talking to an agent. Each
sidebar tab is an app: describe what you want, and the agent assembles it from
a catalog of UI components and backend operations. Apps persist with their own
database and can be refined by chatting further.

Built with **Electron** + **SolidJS** (styled with **StyleX**), backed by a local
**Bun** server using **SQLite** and the **Claude Agent SDK**.

Bun is used everywhere it can be: package manager, script runner, bundler for the
Electron main/preload scripts, and runtime for the backend server. The only thing
not running on Bun is Electron itself (it ships its own Node runtime).

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.3 and a Claude account logged in to
[Claude Code](https://claude.com/claude-code) (`claude` → `/login`), or a token
from `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`.

```sh
bun install
bun run dev
```

## Scripts

| Command             | What it does                                                                           |
| ------------------- | -------------------------------------------------------------------------------------- |
| `bun run dev`       | Vite dev server (HMR) + Electron. Server hot-reloads, main/preload changes restart Electron. |
| `bun run build`     | Production build into `dist/` (renderer, main/preload, compiled server binary).         |
| `bun run start`     | Runs the production build (unpackaged).                                                 |
| `bun run package`   | Builds and packages a distributable into `release/` via electron-builder.              |
| `bun run server`    | Runs only the Bun server standalone (port 3000), with watch mode.                       |
| `bun run typecheck` | Type-checks the whole project.                                                          |
| `bun run test`      | Unit tests (spec validation, catalog, data layer, icons).                               |
| `bun run e2e`       | Launches the built app with a throwaway profile and drives the UI; add `--agent` to also have the agent build an app (uses your Claude plan). Screenshots land in `test-results/`. |
| `bun run check`     | Everything: typecheck, tests, build, e2e.                                               |

## How it fits together

```
src/
  main/            Electron main process: starts the server, creates the window
  preload/         Exposes `window.gapp` (server URL, versions) to the renderer
  renderer/        SolidJS UI (Vite + StyleX)
    components/    Host UI: sidebar, chat, workspace
    catalog/       Components generated apps are rendered with (charts: TanStack Charts)
  server/          Bun HTTP server (Bun.serve)
    agent.ts       Agent runs via the Claude Agent SDK + gApp's tools
    prompt.ts      System prompt: documents the catalog for the agent
    appdata.ts     Per-app SQLite databases, migrations, data operations
    db.ts          Host database: apps, specs, chat history
  shared/
    spec.ts        App spec schema (zod): tables + UI tree + actions
    catalog.ts     Component docs + live examples (drives the prompt and Catalog page)
    api.ts         HTTP API types
scripts/           Bun scripts for dev / build / start / e2e
tests/             bun:test unit tests
```

### Generated apps

The agent never writes code. It produces an **app spec** (`src/shared/spec.ts`):
tables with typed columns, plus a UI tree built from catalog components. gApp
validates the spec, migrates the app's SQLite database (additive only, so data
is never dropped), and renders it. The agent's tools are `get_app`,
`update_app`, `search_icons`, and `query_rows` / `insert_rows` / `update_rows` /
`delete_rows`; it has no access to files, shell or web.

The **Catalog** page (bottom of the sidebar) shows every component with a live
example, its props, and a searchable list of all Lucide icons. Any Lucide icon
can be used by name; specs with unknown icon names are rejected.

To add a catalog component:

1. Add it to `UINode` in `src/shared/spec.ts` (type, zod schema, `checkReferences`).
2. Document it with an example in `src/shared/catalog.ts` — this also puts it in
   the agent's prompt and on the Catalog page.
3. Implement it in `src/renderer/catalog/components.tsx`.
4. Run `bun run check`; the tests fail if a component is undocumented or an
   example is invalid, and e2e fails if an example doesn't render.

### Agent and auth

The Agent SDK runs the Claude Code binary, which uses your logged-in Claude
account, so no API key is needed (gApp strips `ANTHROPIC_API_KEY` from the agent's
environment on purpose). Each app keeps its own agent session, so follow-up
messages have the full conversation. The model and effort pickers under the
chat input list what your account offers (fetched from Claude Code) and are
remembered per app.

Data lives in Electron's userData dir (`~/.config/gApp/data` on Linux), or
`.data/` when running the server standalone.

On startup the main process picks a free port and spawns the server as a child
process, waits for `/api/health`, then opens the window and passes the server URL
to the renderer through the preload script. When the app quits, the server is
stopped (and it also exits on its own if the app dies unexpectedly).

- **Dev:** the server runs from source with `bun --watch`.
- **Production:** the server is compiled with `bun build --compile` into a
  standalone executable shipped as an extra resource (next to the Claude Code
  binary the SDK drives), so users don't need Bun installed.

In production the renderer is served from a custom `app://` protocol (instead of
`file://`) so it has a proper origin; the server only allows CORS requests from
the renderer's origin.
