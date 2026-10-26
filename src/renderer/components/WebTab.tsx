// A web tab: a browser page (<webview>) with an address bar, an element
// picker and the website agent next to it. Web tabs stay mounted while you
// switch tabs so pages keep their state. Pages load once the workspace's
// extensions run (content scripts at document start), and extension pages
// (options, ones an extension opened) are web tabs too.
import * as stylex from "@stylexjs/stylex";
import type { DidFailLoadEvent, PageFaviconUpdatedEvent, PageTitleUpdatedEvent, WebviewTag } from "electron";
import { createEffect, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { DEFAULT_WORKSPACE, webPartition, type ElementInfo, type PageContext } from "../../shared/api";
import { isExtensionUrl } from "../../shared/extensions";
import { hostOf, normalizeUrl, overrideScript, pageChangeHandlerScript, pageChangesCss, pageChangesScript, scopeMatches } from "../../shared/web";
import { cancelPickScript, pickScript, unmarkScript } from "../lib/picker";
import { settings } from "../lib/settings";
import { appById, isAgentCollapsed, sendPrompt, setAgentCollapsed, states, updatePage } from "../lib/store";
import { showExtensionSettings } from "../lib/extensions";
import { cachedOverride, pageChanges, pagesChanged, registerPage, siteOverride, type ApplyResult, type PageInfo } from "../lib/webtabs";
import { colors, font, radius, space } from "../theme.stylex";
import { Chat, Chip } from "./Chat";
import type { MenuPosition } from "./ContextMenu";
import { openExtensionImport } from "./ExtensionImport";
import { ExtensionsBar } from "./ExtensionsBar";
import { Icon } from "./Icon";
import { NetworkPanel } from "./NetworkPanel";
import { changesFor, PageChangesPopover } from "./PageChanges";

export function WebTab(props: { appId: string; active: boolean }) {
  const initialUrl = untrack(() => appById(props.appId)?.url ?? "");
  // The workspace's session (cookies, logins). A tab moved to another workspace is closed and reopened with the new one.
  const workspaceId = untrack(() => appById(props.appId)?.workspaceId ?? DEFAULT_WORKSPACE);
  const partition = webPartition(workspaceId);
  const [src, setSrc] = createSignal(initialUrl);
  const [address, setAddress] = createSignal(initialUrl);
  const [currentUrl, setCurrentUrl] = createSignal(initialUrl);
  const [loading, setLoading] = createSignal(false);
  const [history, setHistory] = createSignal({ back: false, forward: false });
  const [picking, setPicking] = createSignal(false);
  const [networkOpen, setNetworkOpen] = createSignal(false);
  const [picked, setPicked] = createSignal<ElementInfo[]>([]);
  const [loadError, setLoadError] = createSignal<string>();
  const [menu, setMenu] = createSignal<MenuPosition>();
  const [contentsId, setContentsId] = createSignal<number | null>(null);
  // The webview waits for the workspace's extensions (never long).
  const [prepared, setPrepared] = createSignal(false);
  void window.nathapp.extensions.prepare(workspaceId).finally(() => setPrepared(true));
  const host = () => hostOf(currentUrl());
  const collapsed = () => isAgentCollapsed(props.appId);
  const state = () => states[props.appId];

  let webview: WebviewTag | undefined;
  let addressInput!: HTMLInputElement;
  let ready = false;
  let editing = false;

  // --- Loading ---------------------------------------------------------------------

  let loadWaiters: (() => void)[] = [];
  const loaded = () => {
    for (const fn of loadWaiters.splice(0)) fn();
  };
  const waitForLoad = (timeoutMs = 30_000) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      loadWaiters.push(() => (clearTimeout(timer), resolve()));
    });

  const requireReady = () => {
    if (!webview || !ready) throw new Error("No page is open in this tab yet");
    return webview;
  };
  const info = (): PageInfo =>
    webview && ready ? { url: webview.getURL(), title: webview.getTitle() } : { url: currentUrl(), title: "" };

  function go(input: string) {
    // Chrome's extensions page is NathApp's.
    if (/^chrome:\/\/extensions\/?$/i.test(input.trim())) {
      showExtensionSettings();
      return false;
    }
    const target = isExtensionUrl(input.trim()) ? input.trim() : normalizeUrl(input, settings().web.searchEngine);
    if (!target) return false;
    setAddress(target);
    if (!src()) setSrc(target); // creates the webview
    else webview?.loadURL(target).catch(() => {}); // failures show up as did-fail-load
    return true;
  }

  const updateHistory = () => {
    if (webview && ready) setHistory({ back: webview.canGoBack(), forward: webview.canGoForward() });
  };

  function navigated(url: string, inPage: boolean) {
    setCurrentUrl(url);
    if (!editing) setAddress(url);
    updatePage(props.appId, { url });
    updateHistory();
    if (!inPage) setPicked([]); // the picked elements are gone with the old page
    // Single-page apps: another page, maybe other page changes.
    else void applyChanges();
  }

  // --- Site customizations -----------------------------------------------------------

  // What's applied to the current document: inserted CSS and whether JS ran.
  let cssKey: string | null = null;
  let ranJs = "";
  let lastError: string | undefined;
  let loadApplied: Promise<void> = Promise.resolve();

  const customizing = () => settings().web.overrides && !window.nathapp.safeMode;

  async function activeOverride() {
    const url = webview?.getURL() ?? "";
    const h = /^https?:/i.test(url) ? hostOf(url) : "";
    if (!h || !customizing()) return null;
    const override = await siteOverride(h).catch(() => null);
    return override?.enabled ? override : null;
  }

  async function applyOnLoad() {
    cssKey = null;
    ranJs = "";
    lastError = undefined;
    resetChanges();
    const override = await activeOverride();
    if (override && webview) {
      if (override.css.trim()) cssKey = await webview.insertCSS(override.css).catch(() => null);
      if (override.js.trim()) {
        ranJs = override.js;
        const result = await webview.executeJavaScript(overrideScript(override.js)).catch((e: unknown) => String(e));
        lastError = typeof result === "string" ? result : undefined;
      }
    }
    await syncChanges(true);
  }

  // Page changes applied to the current document: their CSS, the scripts that
  // ran (they can't be taken back), the button handlers, and what failed.
  let changesCss = "";
  let changesCssKey: string | null = null;
  let ranScripts = new Map<string, string>();
  let handlers = new Map<string, string>();
  const [changeErrors, setChangeErrors] = createSignal<Record<string, string>>({});
  const resetChanges = () => {
    changesCss = "";
    changesCssKey = null;
    ranScripts = new Map();
    handlers = new Map();
    setChangeErrors({});
  };
  const activeChanges = () => {
    const url = webview?.getURL() ?? "";
    return customizing() ? pageChanges().filter((c) => c.enabled && scopeMatches(c.scope, url)) : [];
  };

  /** Brings the document in line with the active page changes; false if it had to reload instead. */
  async function syncChanges(fresh: boolean): Promise<boolean> {
    if (!webview) return true;
    const view = webview;
    const list = activeChanges();
    const scripts = list.filter((c) => c.action === "script");
    const stale = [...ranScripts].some(([id, code]) => scripts.find((c) => c.id === id)?.value !== code);
    if (stale && !fresh) {
      view.reload();
      await waitForLoad();
      await loadApplied;
      return false;
    }
    const errors: Record<string, string> = {};
    const run = (code: string) => view.executeJavaScript(code).catch((e: unknown) => ({ __error: String(e) }));
    const css = pageChangesCss(list);
    if (css !== changesCss) {
      if (changesCssKey) await view.removeInsertedCSS(changesCssKey).catch(() => {});
      changesCssKey = css ? await view.insertCSS(css).catch(() => null) : null;
      changesCss = css;
    }
    for (const c of list) {
      if (c.action !== "button" || handlers.get(c.id) === c.onClick) continue;
      const result = await run(pageChangeHandlerScript(c));
      if (result && typeof result === "object" && "__error" in result) errors[c.id] = String(result.__error);
      else handlers.set(c.id, c.onClick ?? "");
    }
    const result = (await run(pageChangesScript(list))) as Record<string, string> | { __error: string } | null;
    if (result && "__error" in result) for (const c of list) errors[c.id] ??= String(result.__error);
    else Object.assign(errors, result ?? {});
    for (const c of scripts) {
      if (ranScripts.has(c.id)) continue;
      ranScripts.set(c.id, c.value ?? "");
      const out = await run(overrideScript(c.value ?? ""));
      if (typeof out === "string") errors[c.id] = out;
      else if (out && typeof out === "object" && "__error" in out) errors[c.id] = String(out.__error);
    }
    setChangeErrors(errors);
    return true;
  }

  // Serialized so concurrent updates (agent + realtime message) don't race.
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };

  function applyOverride(): Promise<ApplyResult> {
    return serialized(async () => {
      if (!webview || !ready) return { applied: false };
      await loadApplied;
      const override = await activeOverride();
      const js = override?.js.trim() ? override.js : "";
      if (js !== ranJs) {
        // Scripts can't be taken back: reload so the new one runs on a fresh page.
        webview.reload();
        await waitForLoad();
        await loadApplied;
      } else {
        if (cssKey) await webview.removeInsertedCSS(cssKey).catch(() => {});
        cssKey = override?.css.trim() ? await webview.insertCSS(override.css).catch(() => null) : null;
        await syncChanges(false);
      }
      return { applied: !!override, error: lastError, changesEnabled: customizing(), changeErrors: changeErrors() };
    });
  }

  /** Applies the page changes as they are now (they changed, or the page did). */
  function applyChanges() {
    return serialized(async () => {
      if (!webview || !ready) return;
      await loadApplied;
      await syncChanges(false);
    });
  }

  createEffect(on(() => settings().web.overrides, () => void applyOverride(), { defer: true }));
  createEffect(on(pageChanges, () => void applyChanges(), { defer: true }));

  // --- Element picker ----------------------------------------------------------------

  async function pick() {
    if (!webview || !ready) return;
    if (picking()) {
      void webview.executeJavaScript(cancelPickScript).catch(() => {});
      return;
    }
    setPicking(true);
    webview.focus();
    try {
      const element = (await webview.executeJavaScript(pickScript, true)) as ElementInfo | null;
      if (element) {
        setPicked((list) => (list.some((p) => p.selector === element.selector) ? list : [...list, element]));
        setAgentCollapsed(props.appId, false);
        queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(`[data-web-tab="${props.appId}"] [data-agent-panel] textarea`)?.focus());
      }
    } catch {
      // the page navigated away mid-pick
    } finally {
      setPicking(false);
    }
  }

  function unpick(element: ElementInfo) {
    setPicked((list) => list.filter((p) => p !== element));
    if (webview && ready) void webview.executeJavaScript(unmarkScript(element.selector)).catch(() => {});
  }

  function send(prompt: string) {
    const page: PageContext | undefined = webview && ready ? { url: webview.getURL(), title: webview.getTitle(), selection: picked() } : undefined;
    setPicked([]);
    if (webview && ready) void webview.executeJavaScript(unmarkScript()).catch(() => {});
    void sendPrompt(props.appId, prompt, page);
  }

  // --- The page handle (agent RPC, shortcuts) --------------------------------------

  const unregister = registerPage(props.appId, {
    info,
    eval: (code) => requireReady().executeJavaScript(code),
    capture: () => window.nathapp.web.capture(requireReady().getWebContentsId()),
    navigate: async (url) => {
      const done = waitForLoad();
      if (!go(url)) throw new Error(`Invalid URL: ${url}`);
      await done;
      await loadApplied;
      return info();
    },
    reload: async () => {
      const view = requireReady();
      const done = waitForLoad();
      view.reload();
      await done;
      await loadApplied;
      return info();
    },
    back: () => webview && ready && webview.goBack(),
    forward: () => webview && ready && webview.goForward(),
    focusAddress: () => {
      addressInput.focus();
      addressInput.select();
    },
    applyOverride,
    overrideChanged: (changed) => {
      if (changed === host()) void applyOverride();
    },
    send,
    webContentsId: () => requireReady().getWebContentsId(),
  });
  onCleanup(unregister);

  // A new tab without a page starts in the address bar.
  createEffect(() => {
    if (props.active && !src()) queueMicrotask(() => addressInput.focus());
  });

  function attach(view: WebviewTag) {
    webview = view;
    view.addEventListener("did-start-loading", () => {
      setLoading(true);
      setLoadError();
    });
    view.addEventListener("did-stop-loading", () => {
      setLoading(false);
      updateHistory();
      loaded();
    });
    view.addEventListener("did-fail-load", (e: DidFailLoadEvent) => {
      // -3 is an aborted load (e.g. a new navigation replaced it).
      if (e.isMainFrame && e.errorCode !== -3) setLoadError(`${e.errorDescription || "Failed to load"} (${e.validatedURL})`);
      loaded();
    });
    view.addEventListener("did-navigate", (e) => navigated(e.url, false));
    view.addEventListener("did-navigate-in-page", (e) => e.isMainFrame && navigated(e.url, true));
    view.addEventListener("page-title-updated", (e: PageTitleUpdatedEvent) => updatePage(props.appId, { title: e.title }));
    view.addEventListener("page-favicon-updated", (e: PageFaviconUpdatedEvent) =>
      updatePage(props.appId, { favicon: e.favicons.find((f) => /^https?:/.test(f)) ?? null }),
    );
    view.addEventListener("dom-ready", () => {
      const first = !ready;
      ready = true;
      if (first) {
        setContentsId(view.getWebContentsId());
        pagesChanged();
      }
      loadApplied = applyOnLoad();
      updateHistory();
    });
  }

  // --- Customization menu --------------------------------------------------------------

  // The address bar's paintbrush: the site's customization and the page changes for this page.
  const override = () => cachedOverride(host());
  const customized = () => !!override() && (override()!.css.trim() !== "" || override()!.js.trim() !== "");
  const changesHere = () => changesFor(currentUrl());
  const changed = () => customized() || changesHere().length > 0;
  const overrideActive = () => customizing() && ((customized() && override()!.enabled) || changesHere().some((c) => c.enabled));

  const pickButton = (size: number) => (
    <button
      type="button"
      title={picking() ? "Cancel picking (Esc)" : "Pick elements on the page for the agent"}
      disabled={!src()}
      onClick={pick}
      {...stylex.attrs(styles.iconButton, picking() && styles.iconButtonOn)}
      data-pick-element
    >
      <Icon name="crosshair" size={size} />
    </button>
  );

  return (
    <div {...stylex.attrs(styles.split)} data-web-tab={props.appId}>
      <div {...stylex.attrs(styles.main)}>
        <div {...stylex.attrs(styles.toolbar)}>
          <button type="button" title="Back (Alt+←)" disabled={!history().back} onClick={() => webview?.goBack()} {...stylex.attrs(styles.iconButton)}>
            <Icon name="arrow-left" size={16} />
          </button>
          <button type="button" title="Forward (Alt+→)" disabled={!history().forward} onClick={() => webview?.goForward()} {...stylex.attrs(styles.iconButton)}>
            <Icon name="arrow-right" size={16} />
          </button>
          <Show
            when={loading()}
            fallback={
              <button type="button" title="Reload (Ctrl+R)" disabled={!src()} onClick={() => webview?.reload()} {...stylex.attrs(styles.iconButton)}>
                <Icon name="rotate-cw" size={15} />
              </button>
            }
          >
            <button type="button" title="Stop" onClick={() => webview?.stop()} {...stylex.attrs(styles.iconButton)}>
              <Icon name="x" size={16} />
            </button>
          </Show>
          <form
            {...stylex.attrs(styles.addressBar)}
            onSubmit={(e) => {
              e.preventDefault();
              if (go(address())) addressInput.blur();
            }}
          >
            <Icon name={isExtensionUrl(currentUrl()) ? "puzzle" : currentUrl().startsWith("https:") ? "lock" : "globe"} size={13} {...stylex.attrs(styles.addressIcon)} />
            <input
              ref={addressInput}
              value={address()}
              placeholder="Search or enter an address"
              spellcheck={false}
              onFocus={(e) => {
                editing = true;
                e.currentTarget.select();
              }}
              onBlur={() => {
                editing = false;
                setAddress(currentUrl() || address());
              }}
              onInput={(e) => setAddress(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setAddress(currentUrl());
                  e.currentTarget.blur();
                }
              }}
              {...stylex.attrs(styles.addressInput)}
              data-address
            />
            <Show when={changed()}>
              <button
                type="button"
                title={overrideActive() ? "This page is changed: see and turn off the changes" : "The changes to this page are off"}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setMenu(menu() ? undefined : { x: r.right - 360, y: r.bottom + 6 });
                }}
                {...stylex.attrs(styles.customized, overrideActive() && styles.customizedOn)}
                data-customized={overrideActive() ? "on" : "off"}
              >
                <Icon name="paintbrush" size={13} />
              </button>
            </Show>
          </form>
          {pickButton(16)}
          <button
            type="button"
            title="Network: the page's requests and data"
            onClick={() => setNetworkOpen(!networkOpen())}
            {...stylex.attrs(styles.iconButton, networkOpen() && styles.iconButtonOn)}
            data-network-button
          >
            <Icon name="network" size={16} />
          </button>
          <ExtensionsBar workspaceId={workspaceId} tabId={contentsId} active={props.active} onImport={openExtensionImport} />
          <Show when={collapsed()}>
            <button
              type="button"
              title="Show agent (Ctrl+J)"
              onClick={() => setAgentCollapsed(props.appId, false)}
              {...stylex.attrs(styles.agentButton)}
              data-agent-show
            >
              <Icon name="bot" size={15} />
              Agent
              <Show when={state()?.running}>
                <span {...stylex.attrs(styles.runningDot)} />
              </Show>
            </button>
          </Show>
        </div>
        <Show when={loading()}>
          <div {...stylex.attrs(styles.progressTrack)}>
            <div {...stylex.attrs(styles.progress)} />
          </div>
        </Show>
        <div {...stylex.attrs(styles.viewport)}>
          <Show when={src() && prepared()} fallback={<Show when={!src()}><StartPage onGo={go} /></Show>}>
            <webview
              ref={attach}
              src={src()}
              partition={partition}
              {...{ allowpopups: "" }}
              {...stylex.attrs(styles.webview)}
            />
          </Show>
          <Show when={picking()}>
            <div {...stylex.attrs(styles.banner)}>Click an element to pick it · Esc to cancel</div>
          </Show>
          <Show when={loadError()}>
            <div {...stylex.attrs(styles.banner, styles.bannerError)}>
              {loadError()}
              <button type="button" onClick={() => webview?.reload()} {...stylex.attrs(styles.bannerButton)}>
                Retry
              </button>
            </div>
          </Show>
        </div>
        <Show when={networkOpen()}>
          <NetworkPanel
            webContentsId={() => {
              try {
                return webview?.getWebContentsId() ?? null;
              } catch {
                return null;
              }
            }}
            workspaceId={() => appById(props.appId)?.workspaceId ?? DEFAULT_WORKSPACE}
            onClose={() => setNetworkOpen(false)}
          />
        </Show>
      </div>
      <Show when={!collapsed() && state()?.loaded}>
        <Chat
          appId={props.appId}
          web
          page={{
            onSend: send,
            tools: pickButton(15),
            top: (
              <Show when={picked().length}>
                <div {...stylex.attrs(styles.chips)}>
                  <For each={picked()}>
                    {(el) => (
                      <Chip
                        label={el.text ? `${el.tag} “${el.text.slice(0, 24)}${el.text.length > 24 ? "…" : ""}”` : el.selector}
                        title={el.selector}
                        onRemove={() => unpick(el)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            ),
          }}
        />
      </Show>
      <Show when={menu()}>
        {(position) => <PageChangesPopover url={currentUrl()} errors={changeErrors()} position={position()} onClose={() => setMenu()} />}
      </Show>
    </div>
  );
}

function StartPage(props: { onGo: (input: string) => boolean }) {
  return (
    <div {...stylex.attrs(styles.start)}>
      <Icon name="globe" size={36} {...stylex.attrs(styles.startIcon)} />
      <p {...stylex.attrs(styles.startText)}>Search or enter an address above.</p>
      <div {...stylex.attrs(styles.startLinks)}>
        <For each={["news.ycombinator.com", "wikipedia.org", "github.com"]}>
          {(site) => (
            <button type="button" onClick={() => props.onGo(site)} {...stylex.attrs(styles.startLink)}>
              {site}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}

const progress = stylex.keyframes({
  "0%": { transform: "translateX(-100%)" },
  "100%": { transform: "translateX(250%)" },
});

const pulse = stylex.keyframes({
  "0%": { opacity: 0.4 },
  "50%": { opacity: 1 },
  "100%": { opacity: 0.4 },
});

const styles = stylex.create({
  split: { display: "flex", height: "100%", minHeight: 0 },
  main: { position: "relative", flex: 1, minWidth: 0, display: "flex", flexDirection: "column" },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 2,
    height: 44,
    flexShrink: 0,
    paddingInline: space.sm,
    borderBottomWidth: 1,
    borderBottomStyle: "solid",
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  iconButton: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 30,
    height: 30,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.sm,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover, ":disabled": "transparent" },
    color: { default: colors.muted, ":hover": colors.text, ":disabled": colors.muted },
    opacity: { default: 1, ":disabled": 0.4 },
    cursor: { default: "pointer", ":disabled": "default" },
  },
  iconButtonOn: { backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft }, color: { default: colors.accent, ":hover": colors.accent } },
  addressBar: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: 6,
    height: 30,
    marginInline: space.xs,
    paddingInline: space.sm,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: colors.border, ":focus-within": colors.accent },
    backgroundColor: colors.surface,
  },
  addressIcon: { flexShrink: 0, color: colors.muted },
  addressInput: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    padding: 0,
    borderStyle: "none",
    outline: "none",
    backgroundColor: "transparent",
    color: colors.text,
    fontSize: font.sm,
  },
  customized: {
    display: "grid",
    placeItems: "center",
    flexShrink: 0,
    width: 22,
    height: 22,
    marginRight: -4,
    padding: 0,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.muted,
    cursor: "pointer",
  },
  customizedOn: { color: colors.accent, backgroundColor: { default: colors.accentSoft, ":hover": colors.accentSoft } },
  agentButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    height: 30,
    marginLeft: space.xs,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: colors.surface, ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    fontWeight: 500,
    cursor: "pointer",
  },
  runningDot: {
    width: 7,
    height: 7,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    animationName: pulse,
    animationDuration: "1.2s",
    animationIterationCount: "infinite",
  },
  // The bar slides past the edges, so the track clips it (else the tab overflows and a scrollbar flickers in).
  progressTrack: { position: "absolute", top: 43, left: 0, right: 0, zIndex: 2, height: 2, overflow: "hidden", pointerEvents: "none" },
  progress: {
    width: "40%",
    height: "100%",
    backgroundColor: colors.accent,
    animationName: progress,
    animationDuration: "1.1s",
    animationIterationCount: "infinite",
    animationTimingFunction: "ease-in-out",
  },
  viewport: { position: "relative", flex: 1, minHeight: 0, backgroundColor: "#ffffff" },
  webview: { position: "absolute", inset: 0, width: "100%", height: "100%" },
  banner: {
    position: "absolute",
    top: space.md,
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 3,
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    maxWidth: "90%",
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    backgroundColor: colors.accent,
    color: colors.accentText,
    fontSize: font.sm,
    fontWeight: 500,
    boxShadow: "0 4px 14px rgb(0 0 0 / 0.18)",
    pointerEvents: "none",
  },
  bannerError: { backgroundColor: colors.danger, pointerEvents: "auto" },
  bannerButton: {
    paddingBlock: 2,
    paddingInline: space.sm,
    borderStyle: "none",
    borderRadius: radius.full,
    backgroundColor: "rgb(255 255 255 / 0.2)",
    color: "inherit",
    fontSize: font.xs,
    fontWeight: 600,
    cursor: "pointer",
  },
  start: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space.md,
    height: "100%",
    backgroundColor: colors.bg,
    color: colors.muted,
  },
  startIcon: { color: colors.accent },
  startText: { margin: 0, fontSize: font.md },
  startLinks: { display: "flex", flexWrap: "wrap", justifyContent: "center", gap: space.sm },
  startLink: {
    paddingBlock: 6,
    paddingInline: space.md,
    borderRadius: radius.full,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    backgroundColor: { default: "transparent", ":hover": colors.surfaceHover },
    color: colors.text,
    fontSize: font.sm,
    cursor: "pointer",
  },
  chips: { display: "flex", flexWrap: "wrap", gap: 4, paddingInline: 4, paddingTop: 2 },
});
