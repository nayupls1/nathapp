// Permissions: what an app or agent may do beyond its own sandbox. When
// something new is requested, the user is asked in the UI (allow once,
// always allow, deny); remembered choices are stored and can be revoked.
// Unanswered requests are denied after a timeout.
import { Context, Deferred, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";
import type { PermissionAction, PermissionGrant, PermissionRequest } from "../../shared/api";
import { topics } from "../../shared/hub";
import { Apps } from "../db/Apps";
import { Hub } from "../Hub";
import { Audit } from "./Audit";

/** The website agents of all web tabs share their site permissions. */
export const WEBSITE_AGENT = "website-agent";

interface GrantRow {
  id: number;
  subject: string;
  action: PermissionAction;
  resource: string;
  decision: "allow" | "deny";
  created_at: string;
  app_name: string | null;
}

export interface AskInput {
  readonly subject: string;
  readonly action: PermissionAction;
  readonly resource: string;
  readonly title: string;
  readonly detail: string;
  readonly timeoutMs: number;
}

export interface PermissionsShape {
  /** The remembered decision, if any. */
  readonly decision: (subject: string, action: PermissionAction, resource: string) => Effect.Effect<"allow" | "deny" | null>;
  /** The remembered decision, else asks the user (false if they deny or don't answer in time). */
  readonly ask: (input: AskInput) => Effect.Effect<boolean>;
  readonly answer: (id: string, allow: boolean, remember: boolean) => Effect.Effect<boolean>;
  readonly pending: Effect.Effect<PermissionRequest[]>;
  readonly list: Effect.Effect<PermissionGrant[]>;
  /** Remembers a decision (from the UI, e.g. letting an app use a global secret). */
  readonly set: (subject: string, action: PermissionAction, resource: string, decision: "allow" | "deny") => Effect.Effect<void>;
  readonly revoke: (id: number) => Effect.Effect<PermissionGrant | null>;
  /** Forgets everything about a subject (the app was deleted). */
  readonly forget: (subject: string) => Effect.Effect<void>;
}

export class Permissions extends Context.Service<Permissions, PermissionsShape>()("nathapp/Permissions") {}

export const subjectName = (subject: string, appName: string | null) => (subject === WEBSITE_AGENT ? "Website agent" : (appName ?? "A deleted app"));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hub = yield* Hub;
  const audit = yield* Audit;
  const apps = yield* Apps;
  const waiting = new Map<string, { request: PermissionRequest; deferred: Deferred.Deferred<boolean> }>();

  const toGrant = (r: GrantRow): PermissionGrant => ({
    id: r.id,
    subject: r.subject,
    subjectName: subjectName(r.subject, r.app_name),
    action: r.action,
    resource: r.resource,
    decision: r.decision,
    createdAt: r.created_at,
  });

  const changed = hub.publish({ type: "permissions-changed", topic: topics.activity });

  const decision = (subject: string, action: PermissionAction, resource: string) =>
    sql<{ decision: "allow" | "deny" }>`SELECT decision FROM permissions WHERE subject = ${subject} AND action = ${action} AND resource = ${resource}`.pipe(
      Effect.map((rows) => rows[0]?.decision ?? null),
      Effect.orDie,
    );

  const set = (subject: string, action: PermissionAction, resource: string, value: "allow" | "deny") =>
    sql`INSERT INTO permissions (subject, action, resource, decision) VALUES (${subject}, ${action}, ${resource}, ${value})
        ON CONFLICT (subject, action, resource) DO UPDATE SET decision = excluded.decision, created_at = excluded.created_at`.pipe(
      Effect.orDie,
      Effect.andThen(changed),
    );

  const nameOf = (subject: string) =>
    subject === WEBSITE_AGENT ? Effect.succeed("Website agent") : apps.get(subject).pipe(Effect.map((a) => a?.name ?? "A deleted app"));

  const resolve = (id: string, allow: boolean) =>
    Effect.gen(function* () {
      const entry = waiting.get(id);
      if (!entry) return false;
      waiting.delete(id);
      yield* Deferred.succeed(entry.deferred, allow);
      yield* hub.publish({ type: "permission-resolved", topic: topics.permissions, id });
      return true;
    });

  return {
    decision,
    set,

    ask: (input) =>
      Effect.gen(function* () {
        const known = yield* decision(input.subject, input.action, input.resource);
        if (known) return known === "allow";
        // The same question asked twice while waiting gets the same answer.
        let entry = [...waiting.values()].find(
          (w) => w.request.subject === input.subject && w.request.action === input.action && w.request.resource === input.resource,
        );
        if (!entry) {
          const request: PermissionRequest = {
            id: crypto.randomUUID(),
            subject: input.subject,
            subjectName: yield* nameOf(input.subject),
            action: input.action,
            resource: input.resource,
            title: input.title,
            detail: input.detail,
            createdAt: new Date().toISOString(),
          };
          entry = { request, deferred: yield* Deferred.make<boolean>() };
          waiting.set(request.id, entry);
          yield* hub.publish({ type: "permission-request", topic: topics.permissions, request });
        }
        const { request, deferred } = entry;
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: input.timeoutMs,
            orElse: () =>
              resolve(request.id, false).pipe(
                Effect.andThen(
                  audit.record({
                    actor: "nathapp",
                    actorLabel: "NathApp",
                    tabId: input.subject === WEBSITE_AGENT ? null : input.subject,
                    action: "permission.timeout",
                    target: `${input.action}${input.resource ? ` ${input.resource}` : ""}`,
                    detail: `${request.subjectName}: nobody answered, denied`,
                    outcome: "denied",
                  }),
                ),
                Effect.as(false),
              ),
          }),
        );
      }),

    answer: (id, allow, remember) =>
      Effect.gen(function* () {
        const entry = waiting.get(id);
        if (!entry) return false;
        const { request } = entry;
        if (remember) yield* set(request.subject, request.action, request.resource, allow ? "allow" : "deny");
        yield* audit.record({
          actor: "user",
          actorLabel: "You",
          tabId: request.subject === WEBSITE_AGENT ? null : request.subject,
          action: allow ? "permission.allow" : "permission.deny",
          target: `${request.action}${request.resource ? ` ${request.resource}` : ""}`,
          detail: `${request.subjectName}${remember ? " (remembered)" : " (once)"}`,
          outcome: allow ? "ok" : "denied",
        });
        return yield* resolve(id, allow);
      }),

    pending: Effect.sync(() => [...waiting.values()].map((w) => w.request)),

    list: sql<GrantRow>`
      SELECT p.*, a.name AS app_name FROM permissions p LEFT JOIN apps a ON a.id = p.subject
      ORDER BY p.created_at DESC`.pipe(Effect.map((rows) => rows.map(toGrant)), Effect.orDie),

    revoke: (id) =>
      Effect.gen(function* () {
        const rows = yield* sql<GrantRow>`
          SELECT p.*, a.name AS app_name FROM permissions p LEFT JOIN apps a ON a.id = p.subject WHERE p.id = ${id}`;
        const row = rows[0];
        if (!row) return null;
        yield* sql`DELETE FROM permissions WHERE id = ${id}`;
        yield* changed;
        return toGrant(row);
      }).pipe(Effect.orDie),

    forget: (subject) => sql`DELETE FROM permissions WHERE subject = ${subject}`.pipe(Effect.orDie, Effect.andThen(changed)),
  } satisfies PermissionsShape;
});

export const layer = Layer.effect(Permissions, make);
