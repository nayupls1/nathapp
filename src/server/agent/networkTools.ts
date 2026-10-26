// The website agent's view of the network: the tab's captured traffic (always
// with credentials redacted), sending requests again with the user's session
// (asks the user once per site; the session's cookies and tokens are used but
// never shown), and saved requests to send later without opening the site.
import { Effect, Schema } from "effect";
import type { NetworkEntry, NetworkEntrySummary, ReplayOverrides, ReplayResult, RequestDraft } from "../../shared/api";
import { topics } from "../../shared/hub";
import { hostOf } from "../../shared/web";
import { Apps } from "../db/Apps";
import { Network } from "../db/Network";
import { Hub } from "../Hub";
import { Permissions, WEBSITE_AGENT } from "../security/Permissions";
import { NoArgs, text, tool } from "./Mcp";
import type { ToolEnv } from "./tools";

const MAX_BODY = 20_000;

const clip = (body: string | null, max = MAX_BODY) =>
  body === null ? null : body.length > max ? `${body.slice(0, max)}… (${body.length - max} more characters)` : body;

const Changes = {
  url: Schema.optionalKey(Schema.String.annotate({ description: "Send it to another URL (e.g. other query parameters)" })),
  method: Schema.optionalKey(Schema.String),
  headers: Schema.optionalKey(
    Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.NullOr(Schema.String) })).annotate({
      description: "Headers to set; a null value removes one",
    }),
  ),
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
};

const toOverrides = (args: { url?: string; method?: string; headers?: readonly { name: string; value: string | null }[]; body?: string | null }): ReplayOverrides => ({
  ...(args.url !== undefined ? { url: args.url } : {}),
  ...(args.method !== undefined ? { method: args.method } : {}),
  ...(args.headers ? { headers: Object.fromEntries(args.headers.map((h) => [h.name, h.value])) } : {}),
  ...(args.body !== undefined ? { body: args.body } : {}),
});

const line = (e: NetworkEntrySummary) =>
  `#${e.id} ${e.method} ${e.status ?? (e.error ? "failed" : "pending")} ${e.type} ${e.url}${e.mimeType ? ` · ${e.mimeType}` : ""}${e.size ? ` · ${e.size} B` : ""}${
    e.durationMs !== null ? ` · ${e.durationMs} ms` : ""
  }${e.error ? ` · ${e.error}` : ""}${e.rule ? ` · rule: ${e.rule}` : ""}`;

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");

const describeResult = (r: ReplayResult) =>
  [
    `HTTP ${r.status} ${r.statusText} · ${r.mimeType || "no content type"} · ${r.size} B · ${r.durationMs} ms · ${r.url}`,
    "",
    headerLines(r.headers),
    "",
    r.body === null ? "(no text body)" : `${clip(r.body)}${r.truncated ? "\n(truncated at 512 kB)" : ""}`,
  ].join("\n");

/** Reading the page's traffic (also for app builders, on their app's preview). */
export const networkReadTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) => hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  return [
    tool(
      "network_requests",
      "The page's recent network requests, newest last (#id method status type url). By default only data (fetch/XHR, JSON, XML…); `all` for everything. Credentials are redacted. Use network_request for one request's headers and bodies.",
      Schema.Struct({
        query: Schema.optionalKey(Schema.String.annotate({ description: "Text in the URL, method, type or status" })),
        all: Schema.optionalKey(Schema.Boolean),
        limit: Schema.optionalKey(Schema.Finite),
      }),
      ({ query, all, limit }) =>
        call<NetworkEntrySummary[]>("network.list", { filter: { query, kind: all ? "all" : "data", limit: Math.min(Math.max(limit ?? 60, 1), 200) } }).pipe(
          Effect.map((list) => (list.length ? list.map(line).join("\n") : "No requests recorded yet (reload the page to capture its traffic).")),
        ),
    ),

    tool(
      "network_request",
      "One captured request: its headers, request body and response body (kept for structured data: JSON, XML, forms, text). Credentials are redacted.",
      Schema.Struct({ id: Schema.String }),
      ({ id }) =>
        call<NetworkEntry | null>("network.get", { id: id.replace(/^#/, "") }).pipe(
          Effect.map((e) =>
            e
              ? [
                  line(e),
                  "",
                  "Request headers:",
                  headerLines(e.requestHeaders),
                  ...(e.requestBody !== null ? ["", "Request body:", clip(e.requestBody)!] : []),
                  "",
                  "Response headers:",
                  headerLines(e.responseHeaders),
                  "",
                  e.responseBody !== null ? `Response body:\n${clip(e.responseBody)}` : `No response body: ${e.bodyNote ?? "none"}`,
                ].join("\n")
              : text(`No request #${id} in the log (it keeps the most recent ones).`, true),
          ),
        ),
    ),
  ];
});

export const networkTools = Effect.fn(function* (env: ToolEnv) {
  const hub = yield* Hub;
  const network = yield* Network;
  const apps = yield* Apps;
  const permissions = yield* Permissions;
  const call = <T>(method: string, params: object = {}, timeoutMs?: number) => hub.rpc<T>(method, { tabId: env.tabId, ...params }, timeoutMs);
  const workspaceId = apps.get(env.tabId).pipe(Effect.map((app) => app?.workspaceId ?? null));

  /** Sending requests with the user's session needs their OK, once per site (or remembered). */
  const mayContact = (url: string) =>
    Effect.gen(function* () {
      const host = hostOf(url);
      if (!host) return { host, allowed: false };
      const allowed = yield* permissions.ask({
        agentTab: env.tabId,
        subject: WEBSITE_AGENT,
        action: "agent.network",
        resource: host,
        title: `Let the website agent send requests to ${host}?`,
        detail: `It wants to send requests to ${host} with your session: your cookies and logins are used, but never shown to it. Requests can change things on the site (post, buy, delete).`,
        timeoutMs: 120_000,
      });
      return { host, allowed };
    });
  const refused = (host: string) => text(`The user didn't allow sending requests to ${host || "that address"}. Nothing was sent.`, true);

  return [
    ...(yield* networkReadTools(env)),

    tool(
      "replay_request",
      "Send a captured request again with the user's session (their cookies and logins are used but never shown to you), optionally changed. Returns the response. The user is asked the first time for each site.",
      Schema.Struct({ id: Schema.String, ...Changes }),
      ({ id, ...changes }) =>
        Effect.gen(function* () {
          const entryId = id.replace(/^#/, "");
          const entry = yield* call<NetworkEntry | null>("network.get", { id: entryId });
          if (!entry) return text(`No request #${id} in the log.`, true);
          const { host, allowed } = yield* mayContact(changes.url ?? entry.url);
          if (!allowed) return refused(host);
          const result = yield* call<ReplayResult>("network.replay", { id: entryId, overrides: toOverrides(changes) }, 45_000);
          yield* env.log(`Sent ${changes.method ?? entry.method} ${host}`);
          return describeResult(result);
        }),
    ),

    tool(
      "save_request",
      "Save a captured request so it can be sent again later without opening the site (send_saved_request, or the user from the Network panel). Its credentials are kept sealed; the session's cookies are used when it's sent.",
      Schema.Struct({ id: Schema.String, name: Schema.String.annotate({ description: "What it fetches, e.g. 'Unread notifications'" }) }),
      ({ id, name }) =>
        Effect.gen(function* () {
          const space = yield* workspaceId;
          if (!space) return text("This tab no longer exists.", true);
          const draft = yield* call<RequestDraft>("network.draft", { id: id.replace(/^#/, "") });
          const saved = yield* network.save(space, name.trim().slice(0, 120) || "Saved request", draft);
          yield* hub.publish({ type: "network-changed", topic: topics.network, what: "requests" });
          yield* env.log(`Saved the request “${saved.name}”`);
          return `Saved as ${saved.id}: ${saved.method} ${saved.url}${saved.hasCredentials ? " (with sealed credentials)" : ""}.`;
        }),
    ),

    tool("saved_requests", "Requests saved in this tab's workspace, to send with send_saved_request.", NoArgs, () =>
      Effect.gen(function* () {
        const space = yield* workspaceId;
        const list = space ? yield* network.saved(space) : [];
        return list.length ? list.map((r) => `${r.id} · ${r.name} · ${r.method} ${r.url}`).join("\n") : "No saved requests in this workspace.";
      }),
    ),

    tool(
      "send_saved_request",
      "Send a saved request with the workspace's session, without opening the site, optionally changed. Returns the response. The user is asked the first time for each site.",
      Schema.Struct({ id: Schema.String, ...Changes }),
      ({ id, ...changes }) =>
        Effect.gen(function* () {
          const saved = yield* network.draftOf(id);
          if (!saved || saved.request.workspaceId !== (yield* workspaceId)) return text(`No saved request ${id} in this workspace.`, true);
          const { host, allowed } = yield* mayContact(changes.url ?? saved.request.url);
          if (!allowed) return refused(host);
          const result = yield* hub.rpc<ReplayResult>(
            "network.replay",
            { workspaceId: saved.request.workspaceId, draft: saved.draft, overrides: toOverrides(changes) },
            45_000,
          );
          yield* env.log(`Sent “${saved.request.name}”`);
          return describeResult(result);
        }),
    ),
  ];
});
