# NathApp

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
  preload/           Exposes `window.nathapp` (server URL, API token, web helpers)
  renderer/          SolidJS UI (Vite + StyleX)
    components/      Sidebar, app tabs (preview + agent), web tabs, settings, agent picker
    lib/             Store, API client, hub connection, picker scripts
  server/            Effect program on effect/http + Bun
    services.ts      How the services are wired together
    Http.ts          Routes, auth (token + origin), MCP endpoint
    Hub.ts           WebSocket hub: pushes agent output, app status, logs; RPC to the renderer
    db/              Host database (tabs, chat, settings, site customizations)
    providers/       Claude, Codex, OpenCode drivers behind one event stream
    agent/           Agent turns, prompts, NathApp's MCP tools
    workspace/       Projects, presets (templates/), sandbox, runtime
  shared/            Types and helpers shared by server and renderer
scripts/             Bun scripts for dev / build / start / e2e
tests/               bun:test tests
```

### Apps

Every app is a project folder (`<data>/apps/<id>`) with a `nathapp.json` that says
how to run it:

```json
{ "install": "bun install", "dev": "bun run dev", "build": "bun run build", "start": "bun run start" }
```

The agent starts from a **preset** (React, vanilla TypeScript, API only; see
`src/server/workspace/presets.ts`): a Bun fullstack server with a SQLite
database, a small realtime library (server `publish`, client `subscribe` /
`useLive`) and `src/tokens.css`, the design tokens generated from your NathApp
theme. It can also write any other stack itself. NathApp gives every app:

- `PORT` (a stable port per app on 127.0.0.1), `APP_URL`
- `DATABASE_PATH` / `DATABASE_URL=file:…` (SQLite inside the project's `.nathapp/`)
- `NODE_ENV` / `NATHAPP_MODE`: development while editing, production when done

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
effort per tab. Every provider gets the same instructions and NathApp's tools,
served over MCP at a per-turn URL: `create_project`, `app_status`,
`restart_app`, `app_logs`, `run_command`, `set_app_info`, `search_icons`, and the
page tools (`get_page`, `inspect`, `run_js`, `screenshot`, `navigate`, `reload`)
that work on the preview or the web page. File editing is the provider's own.

Auth is always the provider's own login: no API keys (NathApp strips
`ANTHROPIC_API_KEY` from Claude's environment on purpose).

### AI in apps

Apps can use AI through NathApp, on the user's own subscription, so apps never
hold API keys. The presets ship `src/ai.ts` (`ai.chat`, `ai.json`, `ai.stream`);
other stacks call the HTTP API directly:

```
POST $NATHAPP_AI_URL/chat          Authorization: Bearer $NATHAPP_AI_TOKEN
{ "messages": [{ "role": "user", "content": "…" }], "system"?: "…", "json"?: true, "stream"?: true }
→ { "text": "…", "json"?: …, "provider": "claude", "model": "haiku" }
GET  $NATHAPP_AI_URL/models        → enabled, model, models, today's usage
```

- **Per-app keys:** every app gets its own random token in its environment (new on each server start, revoked when the app is deleted).
  - The token only works on `/ai/`, not on the rest of NathApp's API.
  - Requests carrying an `Origin` header are refused, so only the app's server can ask, never a page in a browser.
- **No tools:** requests run with the provider's own tools switched off: no files, shell, web or connectors.
  - Claude: `tools: []`, strict MCP config, no claude.ai connectors.
  - Codex: shell, code mode, image viewing, apps and web search turned off, and the user's MCP servers disabled.
  - OpenCode: every tool asks for permission, and NathApp refuses (its free models need the tools to be defined).
  - Each provider was tested by asking it to read a file. The website agent uses the same mode.
- **Limits and visibility:** a daily request limit per app, at most two requests per app at a time, and one line per request in the app's logs (sizes and timing, not content).
- **Settings → AI in apps** turns the feature on or off and picks the model. The default is a fast model (Haiku on Claude).

### Secrets

Apps get secrets (API keys, passwords) as environment variables. A secret belongs to one app (key button in its tab) or is global (Settings → Secrets, behind a warning). Global ones reach only the apps you allow.

- **At rest:** values are encrypted with AES-256-GCM, bound to the secret's scope and name.
  - Electron keeps the key in the OS keychain (`safeStorage`) and passes it to the server over stdin.
  - Without a keychain, the key is a 0600 file, and Settings say so.
- **Never shown again:** the API never returns a value after it's saved. You can replace or delete one, not view it.
- **Only the app's own processes:** the dev, build and start commands get secrets; dependency installs and the agents' `run_command` don't.
  - Secrets go in through the environment, never through process arguments. bwrap gets its environment directly instead of `--setenv`.
  - Values are masked in the app's logs and in command output.
- **Agents never see values:** `list_secrets` shows names; `request_secret` puts a form in the chat for you to fill in.
- **Changes apply right away:** changing, deleting or revoking a secret restarts the apps using it.
- **Limits:** this keeps secrets away from everything that shouldn't have them. An app that legitimately has a secret can still leak it, through its own code or its dependencies.

### Permissions and activity

Anything an app or agent does beyond its own sandbox needs your OK:
- an app using AI;
- an app using a global secret;
- the website agent customizing a site (per host).

NathApp asks in a dialog; you can remember the answer. Unanswered requests are denied after a while. Settings → Permissions lists remembered decisions, each revocable.

The **Activity** page (sidebar) is the audit log: who, what, which tab and when. It records:
- every agent turn and tool call (arguments summarized, long text only as a size);
- AI requests;
- secret changes and injections;
- permission decisions;
- runtime actions.

Values are never logged.

Agents' processes don't get NathApp's own environment variables (`NATHAPP_*`). In particular they don't get the API token, so they can't call NathApp's API around these checks.

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

Data lives in Electron's userData dir (`~/.config/NathApp/data` on Linux), or
`.data/` when running the server standalone.
