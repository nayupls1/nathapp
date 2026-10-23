// The provider abstraction: one interface over Claude Code, Codex and
// OpenCode. A driver runs a turn and reports it as a stream of AgentEvents;
// interrupting the stream stops the turn.
import { relative } from "node:path";
import { Data, Effect, Queue, Stream } from "effect";
import type { ProviderId, ProviderModel, ProviderStatus } from "../../shared/api";
import type { ProviderSettings } from "../../shared/settings";

/** gApp's MCP server for this turn (agent tools: app runtime, pages, …). */
export interface McpEndpoint {
  readonly name: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

export interface TurnInput {
  readonly cwd: string;
  readonly prompt: string;
  /** gApp's instructions, added to the provider's own system prompt. */
  readonly instructions: string;
  readonly model: string | null;
  readonly effort: string | null;
  /** Provider session to continue. */
  readonly resume: string | null;
  readonly mcp: McpEndpoint;
  /**
   * workspace: the provider's own file and shell tools, confined to `cwd`.
   * none: only gApp's MCP tools (the website agent).
   */
  readonly access: "workspace" | "none";
  /** Extra environment for the agent process (PATH with bun). */
  readonly env: Record<string, string>;
}

export type AgentEvent =
  /** The provider session (for resuming the conversation later). */
  | { readonly type: "session"; readonly id: string }
  /** Streamed assistant text. */
  | { readonly type: "delta"; readonly text: string }
  /** A finished assistant message. */
  | { readonly type: "text"; readonly text: string }
  /** One line of activity, e.g. "Edited src/App.tsx". */
  | { readonly type: "tool"; readonly title: string }
  | { readonly type: "error"; readonly message: string };

export class ProviderError extends Data.TaggedError("ProviderError")<{ readonly message: string }> {}

export interface Probe {
  readonly state: ProviderStatus["state"];
  readonly version: string | null;
  readonly binary: string | null;
  readonly message: string | null;
  readonly models: ProviderModel[];
  readonly defaultModel: string | null;
}

export interface ProviderDriver {
  readonly id: ProviderId;
  readonly label: string;
  /** Checks that it's installed and signed in, and lists its models. */
  readonly probe: (settings: ProviderSettings) => Effect.Effect<Probe>;
  readonly run: (input: TurnInput, settings: ProviderSettings) => Stream.Stream<AgentEvent, ProviderError>;
}

// --- Describing tool calls ------------------------------------------------------------

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A path for display: relative to the project when inside it. */
export function displayPath(path: unknown, cwd: string): string {
  if (typeof path !== "string" || !path) return "a file";
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

export const commandTitle = (command: unknown) => {
  const text = Array.isArray(command) ? command.join(" ") : String(command ?? "");
  // Codex wraps commands in `bash -lc "…"`.
  const inner = /^(?:\/\S*\/)?(?:ba|z)?sh -l?c ['"]?([\s\S]*?)['"]?$/.exec(text)?.[1] ?? text;
  return `Ran \`${clip(inner.replace(/\s+/g, " ").trim(), 80)}\``;
};

/** "Edited src/App.tsx" etc. for the common file/shell/web tools of any provider. */
export function describeTool(name: string, input: Record<string, unknown>, cwd: string): string | null {
  const tool = name.toLowerCase();
  const file = input.file_path ?? input.filePath ?? input.path ?? input.notebook_path;
  switch (tool) {
    case "read":
      return `Read ${displayPath(file, cwd)}`;
    case "write":
      return `Wrote ${displayPath(file, cwd)}`;
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "patch":
      return `Edited ${displayPath(file, cwd)}`;
    case "bash":
      return commandTitle(input.command);
    case "glob":
    case "grep":
    case "list":
      return input.pattern ? `Searched for ${clip(String(input.pattern), 60)}` : "Looked through files";
    case "webfetch":
      return input.url ? `Fetched ${clip(String(input.url), 70)}` : "Fetched a page";
    case "websearch":
      return input.query ? `Searched the web for “${clip(String(input.query), 60)}”` : "Searched the web";
    case "todowrite":
    case "todoread":
    case "task":
      return null;
    default:
      return null;
  }
}

// --- Bridging async producers ---------------------------------------------------------

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * A stream of events produced by an async function (SDK iterators, child
 * processes). Interrupting the stream aborts the signal, which must stop the
 * work; a failure after that is reported as a normal end.
 */
export const streamFrom = (
  run: (emit: (event: AgentEvent) => void, signal: AbortSignal) => Promise<void>,
): Stream.Stream<AgentEvent, ProviderError> =>
  Stream.callback<AgentEvent, ProviderError>((queue) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
      yield* Effect.tryPromise({
        try: () => run((event) => void Queue.offerUnsafe(queue, event), controller.signal),
        catch: (err) => new ProviderError({ message: errorMessage(err) }),
      }).pipe(
        Effect.matchEffect({
          onSuccess: () => Queue.end(queue),
          onFailure: (err) => (controller.signal.aborted ? Queue.end(queue) : Queue.fail(queue, err)),
        }),
        Effect.forkScoped,
      );
    }),
  );
