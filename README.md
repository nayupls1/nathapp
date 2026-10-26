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
    workspace/       Projects: an app's lifecycle (Projects.ts), its files and presets (Workspace.ts, templates/), sandbox, runtime
  shared/            Types and helpers shared by server and renderer
scripts/             Bun scripts for dev / build / start / e2e
tests/               bun:test tests
```

### Workspaces

Workspaces keep projects and contexts apart, like Zen Browser's: each is a collection of tabs, shown as icons at the bottom of the tab sidebar. Click one to switch (or Ctrl+Alt+1…9, also from inside web pages), "+" makes a new one, dragging an icon reorders them (`PUT /api/workspaces/order`), dropping a tab on one moves the tab there, and an icon's menu renames it, changes its icon, moves it or deletes it. The current workspace's name is at the top of the sidebar. Each has:
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
- `DATABASE_PATH` / `DATABASE_URL=file:…` (its SQLite database) and `NATHAPP_FILES_DIR` (a folder for uploads and other files), both kept by NathApp outside the project (see App data)
- `NATHAPP_API_URL` / `NATHAPP_API_TOKEN` for NathApp's app API (other apps' data)
- `NODE_ENV` / `NATHAPP_MODE`: development while editing, production when done

Editing follows the agent sidebar. While it's open the app is being **edited**: NathApp
runs the `dev` command (Bun `--hot` with HMR), so the agent's changes show up in the
preview right away. Closing it (Ctrl+J) means **done**: NathApp runs `build` and then
`start` and shows the finished app; "Edit" brings the agent back and the dev server
with it. An agent turn always edits, so it reopens the panel. Dependencies are installed when `package.json` or the
lockfile change.

**One lifecycle.** However an app came to be (the agent's `create_project` or a `nathapp.json` it wrote itself, a template you picked, a copy of another app), it goes through the same steps in `workspace/Projects.ts`: setting up, opening, editing and publishing, copying, moving and deleting. Building (the project's files: `Workspace.ts`, its data: `AppData.ts`), running (`Runtime.ts`) and displaying (the renderer, which only sees `AppDetail` and the hub's messages) stay separate. A copy brings the project along as its first snapshot, but not its data, chat or secrets.

**Sandbox.** With bubblewrap every app process (installs, dev server, the
agent's `run_command`) sees the system read-only, its own project and data folder
read-write, a private `/tmp`, and its own PID/IPC namespaces. Your files and other apps are
invisible, and the environment is cleared. Settings → Apps can turn it off.

### App data

What an app stores belongs to NathApp, not to the project: its database and
files live in `<data>/appdata/<id>`, mounted into the app's sandbox. Rebuilding,
resetting or rewriting the project leaves them alone, and the agent's file
tools never touch them (it reads them with `app_data`). Projects from before
this keep their old `.nathapp/data.sqlite`: it moves there on first start.

- **Look at it:** the database button in an app tab lists the tables and pages through their rows, with search.
- **Export:** a `.tar.gz` with the database, every table as JSON and the files.
- **Delete:** stops the app, deletes its database and files and restarts it. A snapshot is taken first, so History can bring them back.
- **Snapshots:** an app's data is part of its snapshots (`@data/…`). Undo and restore leave it alone unless asked.
- **Other apps' data:** an app can read (never write) another app's tables in the same workspace, after you allow it:

```
GET $NATHAPP_API_URL/data                      Authorization: Bearer $NATHAPP_API_TOKEN
GET $NATHAPP_API_URL/data/<app id>             → its tables (name, row count, columns)
GET $NATHAPP_API_URL/data/<app id>/<table>?offset=&limit=&search=&order=&desc=1&where.<column>=
```

  Like the AI API, it only answers the app's server (no `Origin` header). Every read of another app's data is in Activity. Apps in other workspaces aren't listed and can't ask.

### Agents

Providers are detected at startup (Settings → Providers shows their status,
version and models). The picker in the composer chooses provider, model and
effort per tab. Every provider gets the same instructions and NathApp's tools,
served over MCP at a per-turn URL: `create_project`, `app_status`,
`restart_app`, `app_logs`, `app_data`, `run_command`, `list_app_tools`, `use_app_tool`, the schedule tools, `set_app_info`, `search_icons`, the
tab tools (`list_tabs`, `read_tab`) and the
page tools (`get_page`, `inspect`, `run_js`, `screenshot`, `navigate`, `reload`)
that work on the preview or the web page. File editing is the provider's own.

Auth is always the provider's own login: no API keys (NathApp strips
`ANTHROPIC_API_KEY` from Claude's environment on purpose).

### Shared tab context

Agents can use what's in other tabs of the workspace, when the user shares it:
- **Mentions:** typing `@` in a composer lists the workspace's other tabs; picking one shares it with the next message (a chip above the text, removable).
- **Hand-off:** "Send to…" under an agent's reply passes it to another tab's agent: that tab opens with the reply attached to its next message.
- **Agents asking:** `list_tabs` names the other tabs; `read_tab` reads one after the user allows it (permission `agent.tab`, per tab, rememberable).

What the agent gets (`agent/sharedTabs.ts`, built on the server): a web page's URL, title, selected text and visible text (the main content, up to 30k characters, read by the renderer and waking an unloaded tab); for an app, its tools and how its data is laid out (tables and columns, never rows); and the handed-over reply. It's wrapped in `<shared-tab>`, marked as the tab's content rather than the user's instructions, and every share is in Activity. Only tabs of the same workspace can be shared.

Web pages are untrusted, and so is what a website agent made of one: they only go to website agents, which have no tools of their own (`access: "none"`), never to an app builder (`shareRefusal`, checked by the server). An app's page isn't shared with app builders either, since it can show data from anywhere; they get its tools and data layout.

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
- an **app**: its project files (without `node_modules`, builds, `.git`) and its data (see App data). SQLite databases are copied consistently even while the app runs, and the timeline shows how their tables' row counts changed;
- the **site customizations** and **page changes** the website agent (or you) made;
- NathApp's **settings**, including each workspace's.

Snapshots are taken before and after every agent turn (so what you or the app changed in between is kept apart from what the agent did), when an app starts from a template, and when you change settings or site customizations (changes made in a row are folded together). "Save a snapshot" takes one by hand.

Each entry shows who made the change (which agent, you, NathApp) and its files with line diffs. Two ways back:
- **Undo this change** reverts only that step. It refuses if those files were changed again since.
- **Restore this version** puts everything back the way it was then.

Both keep the app's current data unless you tick "also its data". Restoring or undoing first saves the current state, so it can be undone too. When an app crashes, its tab offers to undo the agent's last change.

If something breaks NathApp's own UI, **safe mode** starts it without the theme and site customizations. Start it with `--safe-mode` or press Ctrl+Alt+Shift+S, undo the change in History, then restart normally.

Contents are stored once (content-addressed, gzipped) under `<data dir>/history/`. The last 200 snapshots are kept per app, for site customizations and for settings.

### Window

The window has no title bar, like Chrome. On Linux and Windows it's frameless and NathApp draws minimize, maximize and close in the top right (`components/WindowControls.tsx`); macOS keeps its traffic lights, top left. The top bars (the tab sidebar's header, a tab's toolbar, the agent sidebar's header) are where the window is dragged, and double-clicking one maximizes it. A bar running under the window's buttons is padded so nothing hides behind them (`lib/windowChrome.ts`).

### Agent sidebar

The agent has one place: the agent sidebar, right of the tabs (`components/AgentSidebar.tsx`). It looks and works the same for every kind of tab: building or editing an app, customizing a site and using it all happen there. It shows the agent of the tab that has the focus (in a split view, the focused pane's), with the tab's name in its header; each tab keeps its own conversation, and what you typed but didn't send stays with the tab. Elements picked in a page (the crosshair) show above its composer (`lib/picks.ts`). Ctrl+J (or the Agent button in a tab) opens or closes it for the tab. It's open by default only where it's needed: on a new app tab, to describe the app. Web pages and other tabs start with it closed and remember being opened; an app's tab follows its mode (open while it's being edited), and apps start finished when NathApp starts.

It's resized like the tab sidebar: drag its left edge (or use the arrow keys on it), double-click for the default width, drag it far to the right to close it. The width is the same in every tab and remembered.

### Sidebar

The sidebar collapses to a column of icons (the button next to the workspace, or Ctrl+Shift+B, also from inside web pages) and is resized by dragging its edge (double-click it for the default width; dragging it far enough to the left collapses it). Its width and whether it's collapsed are remembered.

Tabs are put in order by dragging them up or down (or "Move up"/"Move down" in their menu). The order is saved per workspace (`PUT /api/workspaces/:id/order`); new tabs, copies and tabs moved in from another workspace go last.

Every tab can have its own icon ("Change icon…" in its menu): a Lucide icon (searchable), an emoji or an uploaded image (scaled to a 64px PNG). It's shown in the sidebar and the command bar; "Use the default" brings back the app icon or the site's favicon. An app's agent picks an icon with `set_app_info` (a Lucide name, or `icon_file`, an image from the project), but never replaces one you chose.

### Tab unloading

Tabs that haven't been on screen for a while are unloaded: their page (a web page or an app's preview) closes and frees its memory (Settings → Tabs: after 30 minutes by default, or never). They're dimmed in the sidebar and come back where you left them when opened: the same page, scroll position (the window's and scrolled containers') and what you typed, put back through the fields' own setters so frameworks notice. Passwords, hidden and file inputs and card fields aren't kept, and the rest lives only in memory (`lib/pagestate.ts`).

- **Never unloaded:** tabs on screen (in a split, all of its tabs), tabs whose agent is working, pages playing sound, and pinned tabs ("Keep loaded" in a tab's menu, saved with the tab: `PUT /api/apps/:id/pinned`).
- **By hand:** "Unload" in a tab's menu, or "Unload other tabs" in the command bar.
- **Background work:** an agent's page tools wake an unloaded tab in the background (`wakePage` in `lib/webtabs.ts`) and it stays loaded until it's idle again. The chat keeps streaming, and an app's server keeps running for schedules, tools and other apps.
- **Not kept:** a page's back/forward history, and anything only in its JavaScript memory. Extensions only see loaded tabs.

### Split view

Tabs of a workspace can be shown side by side or stacked, any kind together (apps, web tabs, extension pages), up to four at once.
- **Making one:** drag a tab from the sidebar onto a side of the tab on screen (or onto an end of the split on screen), choose "Show beside …" in a tab's menu, or type "split" in the command bar.
- **Using it:** clicking into a pane focuses its tab (the outlined one; shortcuts and the address bar go to it). Drag the line between panes to resize them, double-click it for equal sizes.
- **In the sidebar** a split is one block with its tabs, which takes the place of its first tab. Its handle drags the whole split, its menu stacks or unstacks it, evens out the sizes or unsplits it. Dropping a tab next to one of its tabs adds it there, dropping one of its tabs elsewhere takes it out.
- **Saved** with the workspace (`PUT /api/workspaces/:id/splits`, kept consistent by `normalizeSplits`): a deleted or moved tab leaves its split, and a split of one ends.

Tabs aren't moved in the DOM for this (a webview that moves reloads): every tab keeps its layer, and a split only places its tabs' layers in their panes (`components/SplitView.tsx`, `lib/splits.ts`).

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

### Tool registry

Actions are part of a registry of what apps can do, for you, agents and other apps (`workspace/AppTools.ts`). An app's tools are:
- its **actions** (above). `"params": { "month": { "type": "string", "required": true } }` gives agents and apps typed arguments; they arrive as `{ input, params }`, with `X-NathApp-Caller: user | agent | app:<id>`, and the whole JSON reply comes back;
- the **basic tools from its data**: `list-`, `get-`, `add-`, `update-` and `delete-<table>` for each table (not those starting with `_`). `"dataTools": "read"` keeps only list and get, `"none"` turns them off, and an action with the same id replaces one.

Every call goes through NathApp, the hub between apps:
- **You**: the Tools panel (wrench button in an app tab) lists them with a form to run each; actions are also in the command bar.
- **Agents**: `list_app_tools` and `use_app_tool`.
- **Apps**: `GET $NATHAPP_API_URL/tools` lists the workspace's apps and their tools; `POST $NATHAPP_API_URL/tools/<app>/<tool>` with `{ params?, input? }` runs one. Server-only, like the data API.
- **Permissions**: an app and its agent may use the app's own tools. Another app's tools are limited to the same workspace and need your OK: reading data is the app-data permission, anything else is asked per tool. Opening pages is only for you. Every call is in Activity.

Data tools write the app's database directly: the app sees the change on its next read, but open windows aren't told (no realtime publish), and the app's own rules are skipped. Apps with rules worth keeping should replace those tools with actions or set `"dataTools": "read"`.

### Schedules

Schedules run apps' tools and commands in the background, without a tab open (`scheduler/Scheduler.ts`). The Schedules page (sidebar) shows the workspace's schedules, what's running, what's coming up and the past runs with their results and output. Each schedule can be paused, edited, run now or deleted.
- **What:** one of an app's tools from the registry, with params; the call goes through the registry's permissions and audit log, as the user (or as the agent that made it). Or a command in the app's sandbox, without its secrets, like `run_command`.
- **When:**
  - once at a time;
  - a cron expression in local time (`0 8 * * 1-5`);
  - an event: NathApp started, an app started or crashed, or one an app sends itself with `POST $NATHAPP_API_URL/events {"name": "new-order"}`.
- **Who:** you on the page, or an app's agent (`create_schedule`, `update_schedule`, `delete_schedule`, `run_schedule`, `list_schedules`) for its own app, after you allow it once per app (`agent.schedule`).
- **Limits:**
  - recurring schedules run at most every 5 minutes, and at most two runs happen at once (the rest wait);
  - a schedule never overlaps itself (the extra run is recorded as skipped), and every run has a time limit (5 s to 30 min, 5 min by default);
  - event runs happen at most every 30 s per schedule;
  - output is capped at 20 kB, and the last 50 runs per schedule are kept.
- **Missed runs:** a run missed while NathApp wasn't running happens once when it starts. Runs that were going when it stopped are marked as failed.
- **Notifications:** a notice when a run fails (or after every run, per schedule), and a system notification when NathApp isn't focused. Every run is in Activity.

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
- an app reading another app's data;
- an app (or its agent) using another app's tools;
- an app's agent creating schedules (once per app);
- the website agent customizing a site or changing pages (per host or pattern);
- the website agent using a site for you (per host), and each action with consequences (every time);
- an agent reading another tab.

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
open page and saves changes that apply on every visit. It gets only the page tools, no files or shell.

**Page changes** (`db/PageChanges.ts`, applied by `shared/web.ts`) are single changes, each with a title:
- **What:** hide elements, restyle them (CSS declarations), replace their text, set an attribute, insert HTML next to or inside them, add a button with a click handler, or a stylesheet or script.
- **Where:** one page (host and path, ignoring query and hash), a site (host), or a pattern (`*.example.com/*`, `example.com/docs/*`; `*.` also covers the bare domain).
- **Lasting:** they're applied on every load and in single-page apps on in-page navigation. A MutationObserver applies them to content the page adds later. CSS goes in through `insertCSS`, so pages' content security policies don't block it, and button handlers are compiled with the injected script rather than `eval`ed.
- **Visible:** the paintbrush in the address bar lists every change on the page (and the site's CSS/JS override) with a switch and a remove button, and Settings → Web tabs lists all of them. Turning one off undoes it in place; only scripts need a reload, since what they did can't be taken back.
- **Tools:** the website agent uses `add_page_change`, `update_page_change`, `remove_page_change` and `list_page_changes`, and asks per site or pattern first (`agent.site`). The API is `/api/page-changes`.
- **History:** changes are part of the site customizations' snapshots (`@changes/<id>.json`).

**Using pages for you.** The website agent can also do things on the web: open pages, click, type, fill in forms, press keys, scroll and wait for content (`agent/browseTools.ts`), with real input events in the tab you're looking at, so it works with your logins there.
- **Every action names its element first** (by selector, visible text or a point on a screenshot; `lib/browse.ts` finds it in the page), so NathApp can check it before anything happens.
- **Your OK per site:** acting on a site with your session asks once per site (`agent.browse`, rememberable in Settings → Permissions).
- **Confirmation every time** for what has consequences: clicking or submitting something that buys, pays, books, sends, posts, subscribes or deletes, submitting a form that takes card details, and typing card details (`agent.confirm`, never remembered). The agent asks for anything else with consequences itself (`confirm_action`). Passwords are never typed: you sign in yourself.
- **Visible:** a marker shows where it clicks or types, and a banner says the agent is using the page, with **Take over**, which stops it.
- **App actions:** what it finds can go into your apps with `use_app_tool` (after your OK for that app's tool).
- **Limits:** the checks read the element's text, name and form, so a site that labels "Buy" as an icon only can slip past the confirmation (the agent is told to use `confirm_action` then). `run_js` can still change a page directly; it's meant for exploring.

The older **site override** (one stylesheet and script per hostname, `set_site_override`) still exists for larger reworks.

Web tab logins are cookies, which are encrypted with a key from the same keychain, like Chrome's. The `EnableCookieEncryption` fuse is set in `electron-builder.yml` for the packaged app, and by `scripts/electron.ts` in `node_modules` for runs from source. As in Chrome, a site's local storage, IndexedDB and cache aren't encrypted. They sit in the 0700 profile folder.

Web tabs say they're plain Chrome, because some sites turn away other browsers. Google's sign-in can tell that NathApp isn't Chrome, though, and refuses a browser that claims to be ("This browser or app may not be secure"). It accepts Electron when the user agent names it. So requests to `accounts.google.com` get Electron's own user agent, through the built-in extension that applies the network rules (`signInRule` in `src/shared/extensions.ts`).

### Mods

Customizations packaged to share with others (sidebar → Mods). A mod is one JSON document (`shared/mods.ts`, format `nathapp-mod`, version 1):
- **What's in it:** page changes (how sites look and work), NathApp's theme, and Chrome Web Store extensions (by id: they're installed from the store, not their settings).
- **Making one:** "Make a mod" picks your own page changes, your theme and your store extensions, and gives a share code (`NATHAPP-MOD:` and the compressed JSON), copied right away, or a file.
- **Installing:** paste a share code or an https link into "Install a mod" (or the command bar), or open a file. A review comes first: what it changes, where it runs its own JavaScript (scripts, buttons, HTML with handlers: flagged as able to read everything there, with your logins), which extensions it installs, whether it changes the theme. A mod with the same id updates the installed one.
- **Gallery:** NathApp's examples (`mods/gallery.ts`), plus galleries you add: https links to JSON files listing mods (`{ "mods": [...] }`). There's no central gallery service: a gallery is any file someone publishes.
- **Undo:** an installed mod can be turned off or removed. Its page changes are marked with it (`mod_id`) and go with it; the theme it replaced comes back (unless you changed the theme since); the extensions it installed are disabled or removed, ones you had before stay.
- **Recorded:** installs, updates, switches and removals are snapshots (site customizations, settings) and in Activity. `/api/mods`, `/api/mods/review`, `/api/mods/package`, `/api/mods/gallery`.
- **Limits:** extensions' own permissions are only known once they're installed (Settings → Extensions shows them). Restoring an older site-customizations snapshot can bring back or drop a mod's page changes without changing the mod's entry.

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
