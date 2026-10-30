# Browsing

[README](../README.md) · [Architecture](architecture.md) · [Concepts](concepts.md) · [Interface](interface.md) · [Browsing](browsing.md) · [Development](development.md) · [Releasing](releasing.md)

## Web tabs

Web tabs are `<webview>`s in their workspace's session, separate from Rune Browser's own. The website agent works on the
open page and saves changes that apply on every visit. It gets only the page tools, no files or shell.

**Page changes** (`db/PageChanges.ts`, applied by `shared/web.ts`) are single changes, each with a title:

- **What:** hide elements, restyle them (CSS declarations), replace their text, set an attribute, insert HTML next to or inside them, add a button with a click handler, or a stylesheet or script.
- **Where:** a site (host; what the agent uses by default, so a change stays when you move around the site), a pattern (`*.example.com/*`, `example.com/docs/*`; `*.` also covers the bare domain), or one page (host and path, ignoring query and hash) when you ask for just that page. A change's scope can be changed from its row (click where it applies).
- **Lasting:** they're applied on every load and in single-page apps on in-page navigation. A MutationObserver applies them to content the page adds later. CSS goes in through `insertCSS`, so pages' content security policies don't block it, and button handlers are compiled with the injected script rather than `eval`ed.
- **Visible:** the paintbrush in the address bar lists every change on the page (and the site's CSS/JS override) with a switch and a remove button, and Settings → Web tabs lists all of them. Turning one off undoes it in place; only scripts need a reload, since what they did can't be taken back.
- **Tools:** the website agent uses `add_page_change`, `update_page_change`, `remove_page_change` and `list_page_changes`, and asks per site or pattern first (`agent.site`). The API is `/api/page-changes`.
- **History:** changes are part of the site customizations' snapshots (`@changes/<id>.json`). The agent improves an existing change rather than adding another, and has `list_snapshots`, `view_snapshot` and `restore_snapshot` (only the site it's on; the app builder has the same for its app). Agents can't delete snapshots.

**Using pages for you.** The website agent can also do things on the web: open pages, click, type, fill in forms, press keys, scroll and wait for content (`agent/browseTools.ts`), with real input events in the tab you're looking at, so it works with your logins there.

- **Every action names its element first** (by selector, visible text or a point on a screenshot; `lib/browse.ts` finds it in the page), so Rune Browser can check it before anything happens.
- **Your OK per site:** acting on a site with your session asks once per site (`agent.browse`, rememberable in Settings → Permissions).
- **Confirmation every time** for what has consequences: clicking or submitting something that buys, pays, books, sends, posts, subscribes or deletes, submitting a form that takes card details, and typing card details (`agent.confirm`, never remembered). The agent asks for anything else with consequences itself (`confirm_action`). Passwords are never typed: you sign in yourself.
- **Visible:** a marker shows where it clicks or types, and a banner says the agent is using the page, with **Take over**, which stops it.
- **App actions:** what it finds can go into your apps with `use_app_tool` (after your OK for that app's tool).
- **Limits:** the checks read the element's text, name and form, so a site that labels "Buy" as an icon only can slip past the confirmation (the agent is told to use `confirm_action` then). `run_js` can still change a page directly; it's meant for exploring.

The older **site override** (one stylesheet and script per hostname, `set_site_override`) still exists for larger reworks.

Web tab logins are cookies, which are encrypted with a key from the same keychain, like Chrome's. The `EnableCookieEncryption` fuse is set in `electron-builder.yml` for the packaged app, and by `scripts/electron.ts` in `node_modules` for runs from source. As in Chrome, a site's local storage, IndexedDB and cache aren't encrypted. They sit in the 0700 profile folder.

Web tabs say they're plain Chrome, because some sites turn away other browsers. Google's sign-in can tell that Rune Browser isn't Chrome, though, and refuses a browser that claims to be ("This browser or app may not be secure"). It accepts Electron when the user agent names it. So requests to `accounts.google.com` get Electron's own user agent, through the built-in extension that applies the network rules (`signInRule` in `src/shared/extensions.ts`).

## Network

Every web tab's traffic is recorded in Electron's main process over the DevTools protocol (`src/main/network.ts`). "Network requests" in the command bar opens the Network panel: requests with their headers and the data they returned, filterable, data (fetch/XHR, JSON, XML, forms) by default.

- **Bounded memory:** the last 500 requests per tab. Response bodies are kept for structured data only, at most 256 kB each, 3 MB per tab and 24 MB in all; the oldest go first. Settings → Network turns recording off.
- **Credentials stay hidden:** cookies, `Authorization` and other credential headers, token-like URL parameters and JSON or form fields (`password`, `accessToken`…), JWTs and bearer tokens show as `[redacted]`. In the panel you can show them; the website agent only ever gets them redacted.
- **Send again:** a captured request is sent again with the workspace's session (its cookies, plus the original credential headers), optionally changed.
- **Save for later:** a saved request is stored per workspace with its credentials sealed (AES-GCM, with a key only the main process uses; the server stores the blob but never returns it). It can be sent from the panel's Saved tab or by the website agent without opening the site.
- **Rules** block requests or set and remove request or response headers, for every workspace or one (Settings → Network, or "Block like this" in the panel). Patterns use `*` over the whole URL, or match text anywhere in it. A small built-in extension applies them as `declarativeNetRequest` session rules (`src/main/extensions/builtin.ts`), so they work alongside extensions like uBlock Origin Lite: Electron turns off every extension's blocking in a session that has `webRequest` hooks. Requests sent again from the panel check the rules themselves.

The website agent has `network_requests`, `network_request`, `replay_request`, `save_request`, `saved_requests` and `send_saved_request`. Sending anything with the user's session asks first, once per site (permission `agent.network`), and every call is in the activity log.

## Extensions

Web tabs run Chrome extensions (Manifest V3 and V2) with Electron's extension support. Each workspace's session loads its own copy, so an extension only sees the tabs of its workspace and keeps separate data there (`chrome.storage.sync` is the exception: one copy per extension, shared). Settings → Extensions lists them. You can add one from the Chrome Web Store (link or ID), load an unpacked folder, or import from a browser. Store extensions update every 5 hours.

**Import from your browser** (Settings → Extensions, or the puzzle menu in a web tab) reads the profiles of Chrome, Chromium, Brave, Edge and Vivaldi (including Flatpak and Snap installs). It offers what's turned on there. Store extensions are copied and keep their IDs. Unpacked ones are used from their folder. They come along with:

- which ones are pinned (at the top of the extensions menu);
- the keyboard shortcuts changed there;
- with "Bring their settings too", what they saved: `chrome.storage.local`, their dynamic blocking rules and IndexedDB (sign-ins, preferences).

An imported extension gets `runtime.onInstalled` with `reason: "update"`, so it doesn't open its welcome pages again.

**APIs.** What Electron lacks is added by a shim that the extension preload (`src/extension-preload/`) injects into extension pages and service workers; the main process does the work (`src/main/extensions/apis.ts`):

- toolbar buttons (`action`, `browserAction`, `pageAction`: badges, popups, per-tab state);
- `tabs`/`windows` (tabs open, select and close through Rune Browser's tab list);
- `commands`, `contextMenus`, `permissions` (optional ones ask first);
- `storage.sync`, `webNavigation`, `cookies`, `notifications`, `idle`, `management`, `downloads.download`, `search`, `system.cpu`/`memory`/`display`;
- `runtime.onInstalled`/`onStartup`/`openOptionsPage`;
- native messaging.

**Site sign-ins** (HTTP Basic/Digest, proxies): Electron cancels them and never asks extensions. Rune Browser handles them itself (`login` in `src/main/web.ts`): extensions that listen to `webRequest.onAuthRequired` (with `webRequestAuthProvider` or `webRequestBlocking`, and access to the site) are asked first, like in Chrome, so password managers fill them in. A retry keeps its request ID, and after two refused answers the extensions aren't asked again. Then Rune Browser's own sign-in dialog asks you (`components/AuthDialog.tsx`). App previews keep Electron's behavior.

Chromium puts its own namespaces back on `chrome` whenever bindings update (another extension loading does that), so the shim extends the namespaces Electron has instead of replacing them.

Stopped service workers are started again for the events they listened to. Electron doesn't enable static `declarativeNetRequest` rulesets by itself, so the shim enables the manifest's defaults on install and update.

**Native messaging** uses the browser's own host manifests (`NativeMessagingHosts` in the browser's profile folder, `/etc/opt/chrome`, `/etc/chromium`), or Rune Browser's own (`<userData>/NativeMessagingHosts`). A host only runs for the extensions in its `allowed_origins`, and doesn't get Rune Browser's environment variables.

**Caveats:**

- **Limited permissions** (`shared/extensions.ts`, `permissionAbout`): what Rune Browser doesn't have gets a stand-in, so the extension keeps working: `history`, `bookmarks`, `sessions`, `tabGroups`, `topSites` are empty, `privacy` and `fontSettings` read as defaults and change nothing, `identity`, `tabCapture`, `gcm` and anything unknown fail with `lastError`, `desktopCapture` acts cancelled. A side panel (`sidePanel`) shows as the popup of its toolbar button, or in a tab. `userScripts` stays missing, like in Chrome with "Allow user scripts" off. Import and the extension's details say what's different for each.
- **Allowing and blocking permissions:** an extension's details list every permission it asks for with a switch. Blocking one restarts the extension; its calls then fail (in the shim and in the main process) and its events don't come. Optional permissions are granted or taken back there too.
- `chrome.storage.sync` data isn't imported (Chrome keeps it in a LevelDB that Rune Browser doesn't parse).
- Settings are imported into each workspace once, when the extension first loads there; later changes stay per workspace.
