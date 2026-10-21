// Runs the builder agent via the Claude Agent SDK. The SDK drives the Claude
// Code binary, which authenticates with the user's own Claude login
// (subscription), so no API key is involved.
import { createSdkMcpServer, query, tool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ChatEvent, Effort, PageContext } from "../shared/api";
import { AppSpec, checkReferences, Value, Where } from "../shared/spec";
import { DataError, migrate, rowCounts, runData } from "./appdata";
import {
  BackendError,
  backendLogs,
  backendStatus,
  backendUrl,
  deleteBackendFile,
  ENTRY,
  listFiles,
  readBackendFile,
  restartBackend,
  runBun,
  stopBackend,
  writeBackendFile,
} from "./backends";
import { agentDir, claudeExecutable } from "./config";
import { addMessage, getApp, getSettings, updateApp } from "./db";
import { agentEnv } from "./env";
import { clearFrameErrors, frameErrors } from "./frames";
import { specChanged } from "./hub";
import { isIcon, searchIcons } from "./icons";
import { buildSystemPrompt } from "./prompt";
import { buildWebPrompt, contextSummary, createWebTools, webToolNames, withPageContext } from "./webagent";

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

  const backendCall = async (fn: () => ReturnType<typeof text> | Promise<ReturnType<typeof text>>) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof BackendError) return text(err.message, true);
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
          clearFrameErrors(appId); // errors from the previous version are moot
          const app = updateApp(appId, { spec, name: spec.name, icon: spec.icon ?? null })!;
          emit({ type: "spec", spec });
          emit({ type: "app", app });
          specChanged(appId);
          log(`Updated app “${spec.name}”`);
          return text("App updated.");
        },
      ),

      tool(
        "get_errors",
        "Errors from the app's custom components (since the last update_app) and the backend's state and recent error output.",
        {},
        async () => {
          // Give freshly reloaded components a moment to run.
          await Bun.sleep(1500);
          const errors = frameErrors(appId);
          const status = backendStatus(appId);
          const parts = [errors.length ? `Custom components:\n${JSON.stringify(errors, null, 2)}` : "Custom components: no errors."];
          if (status.exists) {
            parts.push(`Backend: ${status.state}${status.exitCode !== null ? ` (exit code ${status.exitCode})` : ""}`);
            if (status.state !== "running") parts.push(backendLogs(appId, 30).join("\n"));
          }
          return text(parts.join("\n\n"));
        },
      ),

      // --- Custom backend
      tool("list_files", "List the files of the app's backend folder.", {}, async () => {
        const files = listFiles(appId);
        return text(files.length ? files.map((f) => `${f.path} (${f.size} bytes)`).join("\n") : "No backend files yet.");
      }),

      tool("read_file", "Read a file from the app's backend folder.", { path: z.string() }, async ({ path }) =>
        backendCall(() => text(readBackendFile(appId, path))),
      ),

      tool(
        "write_file",
        `Create or replace a file in the app's backend folder (TypeScript, JSON, …). ${ENTRY} is the entry point. Restart the backend afterwards.`,
        { path: z.string(), content: z.string() },
        async ({ path, content }) =>
          backendCall(() => {
            writeBackendFile(appId, path, content);
            log(`Wrote ${path}`);
            return text(`Wrote ${path} (${content.length} chars).`);
          }),
      ),

      tool("delete_file", "Delete a file from the app's backend folder.", { path: z.string() }, async ({ path }) =>
        backendCall(() => {
          deleteBackendFile(appId, path);
          log(`Deleted ${path}`);
          return text(`Deleted ${path}.`);
        }),
      ),

      tool(
        "restart_backend",
        `(Re)start the app's backend (bun run ${ENTRY} with $PORT) and wait until it listens. Returns its state and recent logs.`,
        {},
        async () =>
          backendCall(async () => {
            const status = await restartBackend(appId);
            log(status.state === "running" ? `Backend running on port ${status.port}` : `Backend ${status.state}`);
            return text(`State: ${status.state}\nRecent logs:\n${backendLogs(appId, 40).join("\n")}`, status.state !== "running");
          }),
      ),

      tool("stop_backend", "Stop the app's backend.", {}, async () => {
        stopBackend(appId);
        log("Stopped backend");
        return text("Stopped.");
      }),

      tool(
        "backend_logs",
        "Recent stdout/stderr lines of the app's backend.",
        { lines: z.number().int().positive().max(500).optional() },
        async ({ lines }) => text(backendLogs(appId, lines ?? 80).join("\n") || "No logs."),
      ),

      tool(
        "call_backend",
        "Send an HTTP request to the app's running backend (to test it). Path starts with /.",
        {
          path: z.string().regex(/^\//),
          method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
          body: z.unknown().optional(),
        },
        async ({ path, method, body }) =>
          backendCall(async () => {
            const base = await backendUrl(appId);
            if (!base) return text(`The backend isn't running (${backendStatus(appId).state}). Use restart_backend.`, true);
            const res = await fetch(`${base}${path}`, {
              method: method ?? "GET",
              headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
              body: body !== undefined ? JSON.stringify(body) : undefined,
            });
            const out = await res.text();
            return text(`${res.status} ${res.statusText}\n${out.length > 6000 ? `${out.slice(0, 6000)}…` : out}`, !res.ok);
          }),
      ),

      tool(
        "run_script",
        "Run a TypeScript file from the backend folder once with Bun (bun run <path>), e.g. to test logic or import data. Times out after 60s.",
        { path: z.string(), args: z.array(z.string()).optional() },
        async ({ path, args }) =>
          backendCall(async () => {
            readBackendFile(appId, path); // must exist inside the folder
            const res = await runBun(appId, ["run", path, ...(args ?? [])]);
            log(`Ran ${path}`);
            return text(
              `${res.timedOut ? "Timed out. " : ""}Exit code ${res.exitCode}\n${res.output || "(no output)"}`,
              res.exitCode !== 0,
            );
          }),
      ),

      tool(
        "install_packages",
        "Add npm packages to the backend (bun add). Only when really needed.",
        { packages: z.array(z.string().regex(/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~<>=*-]+)?$/i)).min(1) },
        async ({ packages }) =>
          backendCall(async () => {
            const res = await runBun(appId, ["add", ...packages], 120_000);
            log(`Installed ${packages.join(", ")}`);
            return text(`Exit code ${res.exitCode}\n${res.output}`, res.exitCode !== 0);
          }),
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
          return text(`Deleted ${changes} rows.`);
        }),
      ),
    ],
  });
}

const toolNames = [
  "get_app",
  "update_app",
  "get_errors",
  "search_icons",
  "query_rows",
  "insert_rows",
  "update_rows",
  "delete_rows",
  "list_files",
  "read_file",
  "write_file",
  "delete_file",
  "restart_backend",
  "stop_backend",
  "backend_logs",
  "call_backend",
  "run_script",
  "install_packages",
].map((name) => `mcp__gapp__${name}`);

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export interface ChatOptions {
  model?: string;
  effort?: Effort;
  /** Web tabs: the page and what the user picked on it. */
  page?: PageContext;
}

export async function runChat(appId: string, prompt: string, emit: Emit, { model, effort, page }: ChatOptions = {}) {
  const app = getApp(appId);
  if (!app) throw new Error("App not found");
  if (running.has(appId)) throw new Error("The agent is already working on this app");

  const abortController = new AbortController();
  running.set(appId, abortController);
  // Web tabs get the website agent: page tools only, no files or shell.
  const web = app.kind === "web";
  if (web && page?.selection.length) emit({ type: "message", message: addMessage(appId, "context", contextSummary(page)) });
  emit({ type: "message", message: addMessage(appId, "user", prompt) });
  const { instructions, webInstructions } = getSettings().agent;

  try {
    const messages = query({
      prompt: web ? withPageContext(prompt, page) : prompt,
      options: {
        // Not snapshotted into the session: the catalog evolves, and resumed
        // conversations about older apps must see the current one.
        systemPrompt: {
          type: "custom",
          prompt: web ? buildWebPrompt(webInstructions) : buildSystemPrompt(instructions),
          snapshot: false,
        },
        resume: app.sessionId ?? undefined,
        tools: [], // no built-in tools (files, shell, web): only gApp's own
        mcpServers: web ? { web: createWebTools(appId, emit) } : { gapp: createTools(appId, emit) },
        allowedTools: web ? webToolNames : toolNames,
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
