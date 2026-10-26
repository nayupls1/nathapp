// Tabs (apps and web tabs) and their chat history.
import { Context, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { AgentChoice, AppMode, AppSummary, ChatMessage, ProviderId, TabKind } from "../../shared/api";
import { hostOf } from "../../shared/web";
import { now, orDieAll, type OrDie } from "./Db";

interface AppRow {
  id: string;
  workspace_id: string;
  kind: TabKind;
  name: string;
  name_locked: number;
  icon: string | null;
  icon_locked: number;
  pinned: number;
  url: string | null;
  favicon: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  session_id: string | null;
  session_provider: string | null;
  mode: string;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface AppRecord extends AppSummary {
  nameLocked: boolean;
  agent: AgentChoice | null;
  /** The provider session to resume, if it belongs to that provider. */
  session: { provider: ProviderId; id: string } | null;
  mode: AppMode;
}

const toSummary = (r: AppRow): AppSummary => ({
  id: r.id,
  workspaceId: r.workspace_id,
  kind: r.kind,
  name: r.name,
  icon: r.icon,
  url: r.url,
  favicon: r.favicon,
  pinned: r.pinned === 1,
  position: r.position,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toRecord = (r: AppRow): AppRecord => ({
  ...toSummary(r),
  nameLocked: r.name_locked === 1,
  agent: r.provider ? { provider: r.provider as ProviderId, model: r.model, effort: r.effort } : null,
  session: r.session_id && r.session_provider ? { provider: r.session_provider as ProviderId, id: r.session_id } : null,
  mode: r.mode === "live" ? "live" : "dev",
});

interface MessageRow {
  id: number;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
}

const toMessage = (r: MessageRow): ChatMessage => ({ id: r.id, role: r.role, content: r.content, createdAt: r.created_at });

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const row = (id: string) => sql<AppRow>`SELECT * FROM apps WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0] ?? null));
  const touch = (id: string) => sql`UPDATE apps SET updated_at = ${sql.literal(now)} WHERE id = ${id}`;
  const summary = (id: string) => row(id).pipe(Effect.map((r) => (r ? toSummary(r) : null)));
  /** After the last tab of a workspace. */
  const lastPosition = (workspaceId: string) => sql`(SELECT COALESCE(MAX(position), 0) + 1 FROM apps WHERE workspace_id = ${workspaceId})`;

  const repo = {
    list: () => sql<AppRow>`SELECT * FROM apps ORDER BY position, created_at, rowid`.pipe(Effect.map((rows) => rows.map(toSummary))),

    get: (id: string) => row(id).pipe(Effect.map((r) => (r ? toRecord(r) : null))),

    create: (workspaceId: string, kind: TabKind, url: string | null) =>
      Effect.gen(function* () {
        const id = crypto.randomUUID();
        const name = kind === "web" ? hostOf(url) || "New tab" : "New app";
        yield* sql`INSERT INTO apps (id, workspace_id, kind, name, url, position)
          VALUES (${id}, ${workspaceId}, ${kind}, ${name}, ${url}, ${lastPosition(workspaceId)})`;
        return (yield* summary(id))!;
      }),

    /** Web tab navigation: remembers the URL, favicon and (unless renamed) the page title. */
    updateWebTab: (id: string, fields: { url?: string; title?: string; favicon?: string | null }) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r || r.kind !== "web") return null;
        const title = fields.title?.trim();
        yield* sql`UPDATE apps SET
          url = ${fields.url ?? r.url},
          favicon = ${fields.favicon !== undefined ? fields.favicon : r.favicon},
          name = ${title && !r.name_locked ? title.slice(0, 120) : r.name},
          updated_at = ${sql.literal(now)}
          WHERE id = ${id}`;
        return yield* summary(id);
      }),

    /** A rename by the user: page titles and the agent leave the name alone from now on. */
    rename: (id: string, name: string) =>
      sql`UPDATE apps SET name = ${name}, name_locked = 1, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    /** Name and icon chosen by the agent (not over the user's). */
    setInfo: (id: string, info: { name?: string; icon?: string | null }) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const name = info.name && !r.name_locked ? info.name.slice(0, 80) : r.name;
        const icon = info.icon !== undefined && !r.icon_locked ? info.icon : r.icon;
        yield* sql`UPDATE apps SET name = ${name}, icon = ${icon}, updated_at = ${sql.literal(now)} WHERE id = ${id}`;
        return yield* summary(id);
      }),

    /** An icon the user chose (the agent leaves it alone from now on), or null for the default again. */
    setIcon: (id: string, icon: string | null) =>
      sql`UPDATE apps SET icon = ${icon}, icon_locked = ${icon === null ? 0 : 1}, updated_at = ${sql.literal(now)} WHERE id = ${id}`.pipe(
        Effect.andThen(summary(id)),
      ),

    /** Kept loaded (the renderer doesn't unload it when it's idle). */
    setPinned: (id: string, pinned: boolean) =>
      sql`UPDATE apps SET pinned = ${pinned ? 1 : 0} WHERE id = ${id}`.pipe(Effect.andThen(summary(id))),

    setAgent: (id: string, agent: AgentChoice) =>
      sql`UPDATE apps SET provider = ${agent.provider}, model = ${agent.model}, effort = ${agent.effort} WHERE id = ${id}`.pipe(Effect.asVoid),

    setSession: (id: string, session: { provider: ProviderId; id: string } | null) =>
      sql`UPDATE apps SET session_id = ${session?.id ?? null}, session_provider = ${session?.provider ?? null} WHERE id = ${id}`.pipe(
        Effect.asVoid,
      ),

    /** Moves a tab to another workspace. */
    move: (id: string, workspaceId: string) =>
      sql.withTransaction(
        Effect.all([
          sql`UPDATE apps SET workspace_id = ${workspaceId}, position = ${lastPosition(workspaceId)}, updated_at = ${sql.literal(now)} WHERE id = ${id}`,
          // Its history goes along.
          sql`UPDATE snapshots SET workspace_id = ${workspaceId} WHERE tab_id = ${id}`,
        ]),
      ).pipe(Effect.andThen(summary(id))),

    /** Puts a workspace's tabs in this order (ids of other workspaces are ignored). */
    reorder: (workspaceId: string, ids: readonly string[]) =>
      sql.withTransaction(
        Effect.forEach(ids, (id, i) => sql`UPDATE apps SET position = ${i} WHERE id = ${id} AND workspace_id = ${workspaceId}`, { discard: true }),
      ).pipe(
        Effect.andThen(sql<AppRow>`SELECT * FROM apps WHERE workspace_id = ${workspaceId} ORDER BY position, created_at, rowid`),
        Effect.map((rows) => rows.map(toSummary)),
      ),

    setMode: (id: string, mode: AppMode) => sql`UPDATE apps SET mode = ${mode} WHERE id = ${id}`.pipe(Effect.asVoid),

    touch: (id: string) => touch(id).pipe(Effect.asVoid),

    /** Copies a tab's name, icon, URL and agent settings (not its chat) to a new tab. */
    duplicate: (id: string) =>
      Effect.gen(function* () {
        const r = yield* row(id);
        if (!r) return null;
        const copyId = crypto.randomUUID();
        yield* sql`INSERT INTO apps (id, workspace_id, kind, name, icon, icon_locked, url, favicon, provider, model, effort, mode, position)
          VALUES (${copyId}, ${r.workspace_id}, ${r.kind}, ${`${r.name} copy`}, ${r.icon}, ${r.icon_locked}, ${r.url}, ${r.favicon}, ${r.provider}, ${r.model}, ${r.effort}, ${r.mode}, ${lastPosition(r.workspace_id)})`;
        return (yield* summary(copyId))!;
      }),

    remove: (id: string) => sql`DELETE FROM apps WHERE id = ${id}`.pipe(Effect.asVoid),

    messages: (appId: string) =>
      sql<MessageRow>`SELECT * FROM messages WHERE app_id = ${appId} ORDER BY id`.pipe(Effect.map((rows) => rows.map(toMessage))),

    addMessage: (appId: string, role: ChatMessage["role"], content: string) =>
      sql<MessageRow>`INSERT INTO messages (app_id, role, content) VALUES (${appId}, ${role}, ${content}) RETURNING *`.pipe(
        Effect.map((rows) => toMessage(rows[0]!)),
      ),

    /** Deletes the chat history and forgets the agent session, so the next message starts fresh. */
    clearMessages: (appId: string) =>
      sql.withTransaction(
        Effect.all([
          sql`DELETE FROM messages WHERE app_id = ${appId}`,
          sql`UPDATE apps SET session_id = NULL, session_provider = NULL, updated_at = ${sql.literal(now)} WHERE id = ${appId}`,
        ]),
      ).pipe(Effect.asVoid),
  };
  return repo;
});

export class Apps extends Context.Service<Apps, OrDie<Effect.Success<typeof make>>>()("nathapp/Apps") {}

export const layer = Layer.effect(Apps, Effect.map(make, orDieAll));
