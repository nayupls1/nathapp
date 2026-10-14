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

## How it fits together

```
src/
  main/            Electron main process: starts the server, creates the window
  preload/         Exposes `window.gapp` (server URL, versions) to the renderer
  renderer/        SolidJS UI (Vite + StyleX)
    components/    Host UI: sidebar, chat, workspace
    catalog/       Components generated apps are rendered with
  server/          Bun HTTP server (Bun.serve)
    agent.ts       Agent runs via the Claude Agent SDK + gApp's tools
    prompt.ts      System prompt: documents the catalog for the agent
    appdata.ts     Per-app SQLite databases, migrations, data operations
    db.ts          Host database: apps, specs, chat history
  shared/
    spec.ts        App spec schema (zod): tables + UI tree + actions
    api.ts         HTTP API types
scripts/           Bun scripts for dev / build / start
```

### Generated apps

The agent never writes code. It produces an **app spec** (`src/shared/spec.ts`):
tables with typed columns, plus a UI tree built from catalog components (`stack`,
`card`, `tabs`, `heading`, `text`, `form`, `table`, `list`, `stat`, `chart`,
`button`). gApp validates the spec, migrates the app's SQLite database (additive
only, so data is never dropped), and renders it. The agent's tools are
`get_app`, `update_app`, and `query_rows` / `insert_rows` / `update_rows` /
`delete_rows`; it has no access to files, shell or web.

To add a catalog component: add it to `UINode` in `spec.ts` (type, schema and
`checkReferences`), implement it in `src/renderer/catalog/components.tsx`, and
document it in `src/server/prompt.ts`.

### Agent and auth

The Agent SDK runs the Claude Code binary, which uses your logged-in Claude
account, so no API key is needed (gApp strips `ANTHROPIC_API_KEY` from the agent's
environment on purpose). Each app keeps its own agent session, so follow-up
messages have the full conversation. Set `GAPP_MODEL` to override the model.

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
