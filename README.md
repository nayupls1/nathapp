# NathApp

Desktop app for building small personal apps by talking to a coding agent, and
for browsing the web with an agent that can customize sites. Each sidebar tab
is an app or a web tab, grouped into workspaces. Describe an app and the agent builds it: a real project
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
    db/              Host database (workspaces, tabs, chat, settings, site customizations)
    providers/       Claude, Codex, OpenCode drivers behind one event stream
    agent/           Agent turns, prompts, NathApp's MCP tools
    history/         Snapshots: content store, diffs, undo and restore
    workspace/       Projects, presets (templates/), sandbox, runtime
  shared/            Types and helpers shared by server and renderer
scripts/             Bun scripts for dev / build / start / e2e
tests/               bun:test tests
```

### Workspaces

Workspaces keep projects and contexts apart (switcher at the top of the sidebar). Each has:
- its own tabs. Tabs can be moved between workspaces (tab menu → Move to);
- its own default agent and instructions, added after the global ones (Settings → Workspace);
- secrets every app in it gets (an app's own secret of the same name wins);
- remembered permissions: an answer can be remembered for one app or for every app in the workspace (the app's own choice wins);
- its own web session, so cookies and logins don't cross workspaces. The first workspace keeps the original session;
- its own view of the Activity page (plus what belongs to no workspace, like global secrets).

Switching keeps every opened tab running, and each workspace reopens on the tab you were last on. Deleting a workspace deletes its tabs with their projects and data, its secrets and permissions, and clears its web session. The last workspace can't be deleted. In the code, `db/Workspaces.ts` is this grouping; `workspace/Workspace.ts` is an app's project folder.

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

### History

Every change is saved as a snapshot you can look at and take back (History page in the sidebar; the clock button in an app tab). A snapshot covers one of:
- an **app**: its project files (without `node_modules`, builds, `.git`) and its data. SQLite databases are copied consistently even while the app runs, and the timeline shows how their tables' row counts changed;
- the **site customizations** the website agent made;
- NathApp's **settings**, including each workspace's.

Snapshots are taken before and after every agent turn (so what you or the app changed in between is kept apart from what the agent did), when an app starts from a template, and when you change settings or site customizations (changes made in a row are folded together). "Save a snapshot" takes one by hand.

Each entry shows who made the change (which agent, you, NathApp) and its files with line diffs. Two ways back:
- **Undo this change** reverts only that step. It refuses if those files were changed again since.
- **Restore this version** puts everything back the way it was then.

Both keep the app's current data unless you tick "also its data". Restoring or undoing first saves the current state, so it can be undone too. When an app crashes, its tab offers to undo the agent's last change.

If something breaks NathApp's own UI, **safe mode** starts it without the theme and site customizations. Start it with `--safe-mode` or press Ctrl+Alt+Shift+S, undo the change in History, then restart normally.

Contents are stored once (content-addressed, gzipped) under `<data dir>/history/`. The last 200 snapshots are kept per app, for site customizations and for settings.

### Command bar

Ctrl+K opens it from anywhere, including inside web pages and app previews. It finds tabs (in every workspace), workspaces, NathApp's own commands (new tab, rename, move, snapshot, theme, safe mode…) and the actions apps offer. Free text is routed: a URL opens in a tab; a sentence nothing matches goes to the agent of the tab you're on, or builds a new app; anything else can be searched for on the web. Commands that need text (rename, "Add expense") ask for it after you pick them, or take it inline: `add expense lunch 12`.

Apps declare their actions in `nathapp.json`:

```json
"actions": [
  { "id": "report", "title": "Monthly report", "path": "/report" },
  { "id": "add-expense", "title": "Add expense", "endpoint": "/api/actions/add-expense", "input": "What and how much" }
]
```

- `path` opens the app at that page.
- `endpoint`: NathApp starts the app if needed and POSTs `{ "input": … }` to its own server. The JSON reply's `message` (or `error`) is shown as a notice, and the call is recorded in Activity.
- Paths and endpoints are always on the app's own server. Invalid actions are left out rather than breaking the manifest.

### Secrets

Apps get secrets (API keys, passwords) as environment variables. A secret belongs to one app (key button in its tab), to a workspace (Settings → Workspace, for all its apps) or is global (Settings → Secrets, behind a warning). Global ones reach only the apps you allow.

- **At rest:** values are encrypted with AES-256-GCM, bound to the secret's scope and name.
  - Electron keeps the key in the OS keychain (`safeStorage`) and passes it to the server over stdin.
  - Without a keychain, the key is a 0600 file, and Settings say so.
  - On Linux desktops Chromium doesn't recognize (Hyprland, Sway…), NathApp asks for the Secret Service (gnome-keyring, KeePassXC…) itself (`--password-store=gnome-libsecret`). KDE's KWallet is found on its own.
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

Web tabs are `<webview>`s in their workspace's session, separate from NathApp's own. The website agent works on the
open page and saves site customizations (CSS/JS per hostname) that apply on
every visit. It gets only the page tools, no files or shell.

Web tab logins are cookies, which are encrypted with a key from the same keychain, like Chrome's. The `EnableCookieEncryption` fuse is set in `electron-builder.yml` for the packaged app, and by `scripts/electron.ts` in `node_modules` for runs from source. As in Chrome, a site's local storage, IndexedDB and cache aren't encrypted. They sit in the 0700 profile folder.

Web tabs say they're plain Chrome, because some sites turn away other browsers. Google's sign-in can tell that NathApp isn't Chrome, though, and refuses a browser that claims to be ("This browser or app may not be secure"). It accepts Electron when the user agent names it. So requests to `accounts.google.com` get Electron's own user agent, through the built-in extension that applies the network rules (`signInRule` in `src/shared/extensions.ts`).

### Network

Every web tab's traffic is recorded in Electron's main process over the DevTools protocol (`src/main/network.ts`). The network button in the toolbar opens the Network panel: requests with their headers and the data they returned, filterable, data (fetch/XHR, JSON, XML, forms) by default.

- **Bounded memory:** the last 500 requests per tab. Response bodies are kept for structured data only, at most 256 kB each, 3 MB per tab and 24 MB in all; the oldest go first. Settings → Network turns recording off.
- **Credentials stay hidden:** cookies, `Authorization` and other credential headers, token-like URL parameters and JSON or form fields (`password`, `accessToken`…), JWTs and bearer tokens show as `[redacted]`. In the panel you can show them; the website agent only ever gets them redacted.
- **Send again:** a captured request is sent again with the workspace's session (its cookies, plus the original credential headers), optionally changed.
- **Save for later:** a saved request is stored per workspace with its credentials sealed (AES-GCM, with a key only the main process uses; the server stores the blob but never returns it). It can be sent from the panel's Saved tab or by the website agent without opening the site.
- **Rules** block requests or set and remove request or response headers, for every workspace or one (Settings → Network, or "Block like this" in the panel). Patterns use `*` over the whole URL, or match text anywhere in it. A small built-in extension applies them as `declarativeNetRequest` session rules (`src/main/extensions/builtin.ts`), so they work alongside extensions like uBlock Origin Lite: Electron turns off every extension's blocking in a session that has `webRequest` hooks. Requests sent again from the panel check the rules themselves.

The website agent has `network_requests`, `network_request`, `replay_request`, `save_request`, `saved_requests` and `send_saved_request`. Sending anything with the user's session asks first, once per site (permission `agent.network`), and every call is in the activity log.

### Extensions

Web tabs run Chrome extensions (Manifest V3 and V2) with Electron's extension support. Each workspace's session loads its own copy, so an extension only sees the tabs of its workspace and keeps separate data there (`chrome.storage.sync` is the exception: one copy per extension, shared). Settings → Extensions lists them. You can add one from the Chrome Web Store (link or ID), load an unpacked folder, or import from a browser. Store extensions update every 5 hours.

**Import from your browser** (Settings → Extensions, or the puzzle menu in a web tab) reads the profiles of Chrome, Chromium, Brave, Edge and Vivaldi (including Flatpak and Snap installs). It offers what's turned on there. Store extensions are copied and keep their IDs. Unpacked ones are used from their folder. They come along with:

- their pinned toolbar buttons;
- the keyboard shortcuts changed there;
- with "Bring their settings too", what they saved: `chrome.storage.local`, their dynamic blocking rules and IndexedDB (sign-ins, preferences).

An imported extension gets `runtime.onInstalled` with `reason: "update"`, so it doesn't open its welcome pages again.

**APIs.** What Electron lacks is added by a shim that the extension preload (`src/extension-preload/`) injects into extension pages and service workers; the main process does the work (`src/main/extensions/apis.ts`):

- toolbar buttons (`action`, `browserAction`, `pageAction`: badges, popups, per-tab state);
- `tabs`/`windows` (tabs open, select and close through NathApp's tab list);
- `commands`, `contextMenus`, `permissions` (optional ones ask first);
- `storage.sync`, `webNavigation`, `cookies`, `notifications`, `idle`, `management`;
- `runtime.onInstalled`/`onStartup`/`openOptionsPage`;
- native messaging.

Stopped service workers are started again for the events they listened to. Electron doesn't enable static `declarativeNetRequest` rulesets by itself, so the shim enables the manifest's defaults on install and update.

**Native messaging** uses the browser's own host manifests (`NativeMessagingHosts` in the browser's profile folder, `/etc/opt/chrome`, `/etc/chromium`), or NathApp's own (`<userData>/NativeMessagingHosts`). A host only runs for the extensions in its `allowed_origins`, and doesn't get NathApp's environment variables.

**Caveats:**

- Not provided: `userScripts`, `privacy`, `sidePanel`, `tabGroups`, `debugger`. Import and Settings show what an extension asks for that's missing.
- `chrome.storage.sync` data isn't imported (Chrome keeps it in a LevelDB that NathApp doesn't parse).
- Settings are imported into each workspace once, when the extension first loads there; later changes stay per workspace.

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
