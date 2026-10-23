# gApp

Desktop app for building small personal apps by talking to a coding agent, and
for browsing the web with an agent that can customize sites. Each sidebar tab
is an app or a web tab. Describe an app and the agent builds it: a real project
with its own server and SQLite database, running in a light sandbox and shown
next to the chat in a live preview.

Built with **Electron** + **SolidJS** (styled with **StyleX**), backed by a local
**Bun** server written with **Effect v4**. The agents are the coding CLIs you
already use: **Claude Code** (Agent SDK), **Codex** and **OpenCode**.

Bun is used everywhere it can be: package manager, script runner, bundler for the
Electron main/preload scripts, runtime for the backend server and for the apps
themselves. The only thing not running on Bun is Electron itself.

## Getting started

Requires [Bun](https://bun.sh) ≥ 1.3 and at least one agent signed in:
[Claude Code](https://claude.com/claude-code) (`claude` → `/login`, or a token
from `claude setup-token` in `CLAUDE_CODE_OAUTH_TOKEN`), [Codex](https://github.com/openai/codex)
(`codex login`) or [OpenCode](https://opencode.ai). On Linux, install
[bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`) so apps run sandboxed.

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
| `bun run test`      | Unit tests (MCP endpoint, presets, sandbox, runtime, web tabs, API auth).               |
| `bun run e2e`       | Launches the built app with a throwaway profile and drives the UI; add `--agent` to also have the agents build an app and customize a site (uses your Claude plan). Runs on Chromium's headless display backend, so no window opens. Screenshots land in `test-results/`. |
| `bun run check`     | Everything: typecheck, tests, build, e2e.                                               |

## How it fits together

```
src/
  main/              Electron main process: server, window, webview sessions
  preload/           Exposes `window.gapp` (server URL, API token, web helpers)
  renderer/          SolidJS UI (Vite + StyleX)
    components/      Sidebar, app tabs (preview + agent), web tabs, settings, agent picker
    lib/             Store, API client, hub connection, picker scripts
  server/            Effect program on effect/http + Bun
    services.ts      How the services are wired together
    Http.ts          Routes, auth (token + origin), MCP endpoint
    Hub.ts           WebSocket hub: pushes agent output, app status, logs; RPC to the renderer
    db/              Host database (tabs, chat, settings, site customizations)
    providers/       Claude, Codex, OpenCode drivers behind one event stream
    agent/           Agent turns, prompts, gApp's MCP tools
    workspace/       Projects, presets (templates/), sandbox, runtime
  shared/            Types and helpers shared by server and renderer
scripts/             Bun scripts for dev / build / start / e2e
tests/               bun:test tests
```

### Apps

Every app is a project folder (`<data>/apps/<id>`) with a `gapp.json` that says
how to run it:

```json
{ "install": "bun install", "dev": "bun run dev", "build": "bun run build", "start": "bun run start" }
```

The agent starts from a **preset** (React, vanilla TypeScript, API only; see
`src/server/workspace/presets.ts`): a Bun fullstack server with a SQLite
database, a small realtime library (server `publish`, client `subscribe` /
`useLive`) and `src/tokens.css`, the design tokens generated from your gApp
theme. It can also write any other stack itself. gApp gives every app:

- `PORT` (a stable port per app on 127.0.0.1), `APP_URL`
- `DATABASE_PATH` / `DATABASE_URL=file:…` (SQLite inside the project's `.gapp/`)
- `NODE_ENV` / `GAPP_MODE`: development while editing, production when done

**Editing** runs the `dev` command (Bun `--hot` with HMR), so the agent's changes
show up in the preview right away. **Done** runs `build` and then `start` and
shows the finished app. Dependencies are installed when `package.json` or the
lockfile change.

**Sandbox.** With bubblewrap every app process (installs, dev server, the
agent's `run_command`) sees the system read-only, its own project read-write, a
private `/tmp`, and its own PID/IPC namespaces. Your files and other apps are
invisible, and the environment is cleared. Settings → Apps can turn it off.

### Agents

Providers are detected at startup (Settings → Providers shows their status,
version and models). The picker in the composer chooses provider, model and
effort per tab. Every provider gets the same instructions and gApp's tools,
served over MCP at a per-turn URL: `create_project`, `app_status`,
`restart_app`, `app_logs`, `run_command`, `set_app_info`, `search_icons`, and the
page tools (`get_page`, `inspect`, `run_js`, `screenshot`, `navigate`, `reload`)
that work on the preview or the web page. File editing is the provider's own.

Auth is always the provider's own login: no API keys (gApp strips
`ANTHROPIC_API_KEY` from Claude's environment on purpose).

### Web tabs

Web tabs are `<webview>`s in their own session. The website agent works on the
open page and saves site customizations (CSS/JS per hostname) that apply on
every visit. It gets only the page tools, no files or shell.

### Process model and security

On startup the main process picks a free port, generates an API token and
spawns the server, then opens the window and passes URL and token to the
renderer through the preload script. The API requires the token and rejects
browser requests from other origins, since web pages and app previews can
reach 127.0.0.1 too. App previews run in a session per app (cookies don't
separate ports).

- **Dev:** the server runs from source with `bun --watch`.
- **Production:** the server is compiled with `bun build --compile` into a
  standalone executable (next to the Claude Code binary the SDK drives). It
  doubles as the `bun` apps run on (`BUN_BE_BUN=1`), so users don't need Bun.

Data lives in Electron's userData dir (`~/.config/gApp/data` on Linux), or
`.data/` when running the server standalone.
