// Runs the builder agent via the Claude Agent SDK. The SDK drives the Claude
// Code binary, which authenticates with the user's own Claude login
// (subscription), so no API key is involved.
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ChatEvent, Effort } from "../shared/api";
import { AppSpec, checkReferences, Value, Where } from "../shared/spec";
import { DataError, migrate, rowCounts, runData } from "./appdata";
import { agentDir, claudeExecutable } from "./config";
import { addMessage, getApp, getSettings, updateApp } from "./db";
import { agentEnv } from "./env";
import { isIcon, searchIcons } from "./icons";
import { buildSystemPrompt } from "./prompt";

type Emit = (event: ChatEvent) => void;

const running = new Map<string, AbortController>();

export const isRunning = (appId: string) => running.has(appId);

export function stopChat(appId: string) {
  running.get(appId)?.abort();
}

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

function createTools(appId: string, emit: Emit) {
  const log = (content: string) => emit({ type: "message", message: addMessage(appId, "tool", content) });

  const withSpec = <A>(fn: (spec: AppSpec, args: A) => ReturnType<typeof text>) => async (args: A) => {
    const spec = getApp(appId)?.spec;
    if (!spec) return text("The app has no spec yet. Create one with update_app first.", true);
    try {
      return fn(spec, args);
    } catch (err) {
      if (err instanceof DataError) return text(err.message, true);
      throw err;
    }
  };

  return createSdkMcpServer({
    name: "gapp",
    version: "1.0.0",
    tools: [
      tool("get_app", "Get the current app spec (null for a new app) and row counts per table.", {}, async () => {
        const spec = getApp(appId)?.spec ?? null;
        return text(JSON.stringify({ spec, rowCounts: spec ? rowCounts(appId, spec) : {} }, null, 2));
      }),

      tool(
        "update_app",
        "Replace the app's complete spec. Validates it, migrates the database and re-renders the app.",
        { spec: z.looseObject({}).describe("The complete app spec") },
        async ({ spec: input }) => {
          const parsed = AppSpec.safeParse(input);
          if (!parsed.success) return text(`Invalid spec:\n${z.prettifyError(parsed.error)}`, true);
          const problems = checkReferences(parsed.data, { isIcon });
          if (problems.length) return text(`Invalid spec:\n${problems.map((p) => `- ${p}`).join("\n")}`, true);

          const spec = parsed.data;
          migrate(appId, spec);
          const app = updateApp(appId, { spec, name: spec.name, icon: spec.icon ?? null })!;
          emit({ type: "spec", spec });
          emit({ type: "app", app });
          log(`Updated app “${spec.name}”`);
          return text("App updated.");
        },
      ),

      tool(
        "search_icons",
        "Find Lucide icon names by keywords (e.g. 'money', 'calendar check'). Returns the best matches.",
        { query: z.string().min(1) },
        async ({ query }) => {
          const names = searchIcons(query);
          return text(names.length ? names.join(", ") : "No icons found. Try a more general word.");
        },
      ),

      tool(
        "query_rows",
        "Read rows from one of the app's tables.",
        { table: z.string(), where: Where.optional(), limit: z.number().int().positive().max(500).optional() },
        withSpec((spec, args: { table: string; where?: Where; limit?: number }) => {
          const res = runData(appId, spec, { op: "query", ...args, limit: args.limit ?? 50 });
          return text(JSON.stringify(res));
        }),
      ),

      tool(
        "insert_rows",
        "Insert one or more rows into a table.",
        { table: z.string(), rows: z.array(z.record(z.string(), Value)).min(1) },
        withSpec((spec, { table, rows }: { table: string; rows: Record<string, Value>[] }) => {
          for (const values of rows) runData(appId, spec, { op: "action", action: { type: "insert", table, values } });
          log(`Added ${rows.length} row${rows.length === 1 ? "" : "s"} to ${table}`);
          emit({ type: "spec", spec }); // nudges the renderer to refresh data
          return text(`Inserted ${rows.length} rows.`);
        }),
      ),

      tool(
        "update_rows",
        "Update all rows of a table matching `where` (equality filter).",
        { table: z.string(), where: Where, values: z.record(z.string(), Value) },
        withSpec((spec, action: { table: string; where: Where; values: Record<string, Value> }) => {
          const res = runData(appId, spec, { op: "action", action: { type: "update", ...action } });
          const changes = "changes" in res ? res.changes : 0;
          log(`Updated ${changes} row${changes === 1 ? "" : "s"} in ${action.table}`);
          emit({ type: "spec", spec });
          return text(`Updated ${changes} rows.`);
        }),
      ),

      tool(
        "delete_rows",
        "Delete all rows of a table matching `where`. An empty `where` deletes every row.",
        { table: z.string(), where: Where },
        withSpec((spec, action: { table: string; where: Where }) => {
          const res = runData(appId, spec, { op: "action", action: { type: "delete", ...action } });
          const changes = "changes" in res ? res.changes : 0;
          log(`Deleted ${changes} row${changes === 1 ? "" : "s"} from ${action.table}`);
          emit({ type: "spec", spec });
          return text(`Deleted ${changes} rows.`);
        }),
      ),
    ],
  });
}

const toolNames = ["get_app", "update_app", "search_icons", "query_rows", "insert_rows", "update_rows", "delete_rows"].map(
  (name) => `mcp__gapp__${name}`,
);

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export interface ChatOptions {
  model?: string;
  effort?: Effort;
}

export async function runChat(appId: string, prompt: string, emit: Emit, { model, effort }: ChatOptions = {}) {
  const app = getApp(appId);
  if (!app) throw new Error("App not found");
  if (running.has(appId)) throw new Error("The agent is already working on this app");

  const abortController = new AbortController();
  running.set(appId, abortController);
  emit({ type: "message", message: addMessage(appId, "user", prompt) });

  try {
    const messages = query({
      prompt,
      options: {
        // Not snapshotted into the session: the catalog evolves, and resumed
        // conversations about older apps must see the current one.
        systemPrompt: { type: "custom", prompt: buildSystemPrompt(getSettings().agent.instructions), snapshot: false },
        resume: app.sessionId ?? undefined,
        tools: [], // no built-in tools (files, shell, web): only gApp's catalog
        mcpServers: { gapp: createTools(appId, emit) },
        allowedTools: toolNames,
        settingSources: [], // ignore the user's CLAUDE.md, skills, settings
        cwd: agentDir,
        env: agentEnv(),
        includePartialMessages: true,
        abortController,
        pathToClaudeCodeExecutable: claudeExecutable(),
        model: model ?? process.env.GAPP_MODEL,
        effort,
      },
    });

    for await (const msg of messages as AsyncIterable<SDKMessage>) {
      if (msg.type === "system" && msg.subtype === "init") {
        updateApp(appId, { sessionId: msg.session_id });
      } else if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          emit({ type: "delta", text: ev.delta.text });
        }
      } else if (msg.type === "assistant") {
        const content = msg.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("")
          .trim();
        if (content) emit({ type: "message", message: addMessage(appId, "assistant", content) });
      } else if (msg.type === "result" && msg.subtype !== "success") {
        const detail = "errors" in msg && msg.errors.length ? msg.errors.join("\n") : msg.subtype;
        emit({ type: "message", message: addMessage(appId, "error", `Agent stopped: ${detail}`) });
      }
    }
  } catch (err) {
    const content = abortController.signal.aborted ? "Stopped." : `Agent failed: ${errorText(err)}`;
    emit({ type: "message", message: addMessage(appId, "error", content) });
  } finally {
    running.delete(appId);
    emit({ type: "done" });
  }
}
