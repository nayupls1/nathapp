import { describe, expect, test } from "bun:test";
import { parseToolActivity, type ChatMessage } from "../src/shared/api";
import { buildRows, formatElapsed, summarize } from "../src/renderer/lib/timeline";
import { describeTool } from "../src/server/providers/Provider";
import { describeRuneTool } from "../src/server/agent/activity";

let id = 0;
const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
const msg = (role: ChatMessage["role"], content: string, s = 0): ChatMessage => ({
  id: ++id,
  role,
  content,
  createdAt: at(s),
});
const tool = (kind: string, title: string, s = 0) => msg("tool", JSON.stringify({ kind, title }), s);

describe("timeline rows", () => {
  test("groups consecutive tool calls and ends finished turns", () => {
    const rows = buildRows(
      [
        msg("user", "Build it", 0),
        tool("read", "Read a.ts", 1),
        tool("command", "Ran `bun test`", 2),
        msg("assistant", "Done", 3),
        tool("edit", "Edited b.ts", 4),
        msg("user", "Again", 10),
        msg("assistant", "Sure", 75),
      ],
      false,
      true,
    );
    expect(rows.map((r) => r.type)).toEqual([
      "message",
      "work",
      "message",
      "work",
      "turn-end",
      "message",
      "message",
      "turn-end",
    ]);
    expect(rows[1]!.type === "work" && rows[1]!.entries.length).toBe(2);
    expect(rows[4]!.type === "turn-end" && rows[4]!.ms).toBe(4000);
    expect(rows[7]!.type === "turn-end" && rows[7]!.ms).toBe(65000);
  });

  test("the running turn has no end, and a stopped one says so", () => {
    const messages = [msg("user", "Go", 0), tool("read", "Read a.ts", 1)];
    expect(buildRows(messages, true, true).at(-1)!.type).toBe("work");
    const stopped = buildRows([...messages, msg("error", "Stopped.", 5)], false, true);
    expect(stopped.at(-1)).toMatchObject({ type: "turn-end", stopped: true, ms: 5000 });
    // "Stopped." shows only in the turn's end.
    expect(stopped.some((r) => r.type === "message" && r.message.role === "error")).toBe(false);
  });

  test("context and attachments open the next turn", () => {
    const rows = buildRows(
      [msg("user", "One", 0), msg("assistant", "A", 2), msg("context", "{}", 3), msg("user", "Two", 3)],
      true,
      true,
    );
    expect(rows.map((r) => r.type)).toEqual(["message", "message", "turn-end", "message", "message"]);
  });

  test("tool calls can be hidden", () => {
    const rows = buildRows([msg("user", "Go"), tool("read", "Read a.ts"), msg("assistant", "Hi")], true, false);
    expect(rows.map((r) => r.type)).toEqual(["message", "message"]);
  });

  test("summaries count kinds, and files once", () => {
    const entries = [
      { kind: "command", title: "Ran `a`" },
      { kind: "edit", title: "Edited a.ts" },
      { kind: "edit", title: "Edited a.ts" },
      { kind: "edit", title: "Edited b.ts" },
      { kind: "command", title: "Ran `b`" },
    ].map((a, i) => ({ id: i, activity: parseToolActivity(JSON.stringify(a)) }));
    expect(summarize(entries)).toBe("Edited 2 files and ran 2 commands");
    const many = ["read", "web", "screenshot", "network"].map((kind, i) => ({
      id: i,
      activity: { kind: kind as never, title: `${i}` },
    }));
    expect(summarize(many)).toBe("Read 1 file, used the web once and 2 more");
  });

  test("elapsed times", () => {
    expect(formatElapsed(4_200)).toBe("4s");
    expect(formatElapsed(65_000)).toBe("1m 05s");
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});

describe("tool activity", () => {
  test("every provider tool shows, with a kind", () => {
    expect(describeTool("Edit", { file_path: "/p/src/a.ts" }, "/p")).toEqual({
      kind: "edit",
      title: "Edited src/a.ts",
    });
    expect(describeTool("Bash", { command: "bun test" }, "/p")).toEqual({ kind: "command", title: "Ran `bun test`" });
    expect(
      describeTool("TodoWrite", { todos: [{ content: "A", status: "completed" }, { content: "B" }] }, "/p"),
    ).toMatchObject({ kind: "plan", title: "Updated the plan (1/2 done)" });
    expect(describeTool("Task", { description: "Find the bug", prompt: "…" }, "/p")).toMatchObject({
      kind: "agent",
      title: "Started a subagent: Find the bug",
    });
    expect(describeTool("mcp__linear__get_issue", { id: "NAT-1" }, "/p")).toEqual({
      kind: "other",
      title: "Get issue (linear)",
      detail: "id: NAT-1",
    });
    expect(describeTool("SomethingNew", {}, "/p")).toMatchObject({ kind: "other", title: "Something new" });
  });

  test("long commands keep the whole command as detail", () => {
    const command = `echo ${"x".repeat(100)}`;
    const activity = describeTool("Bash", { command }, "/p");
    expect(activity.title.length).toBeLessThan(90);
    expect(activity.detail).toBe(command);
  });

  test("Rune Browser's tools that don't log get a line", () => {
    expect(describeRuneTool("screenshot", {})).toEqual({ kind: "screenshot", title: "Took a screenshot" });
    expect(describeRuneTool("inspect", { selector: ".buy" })).toMatchObject({
      kind: "inspect",
      title: "Inspected .buy",
    });
    expect(describeRuneTool("brand_new_tool", { a: 1 })).toEqual({
      kind: "other",
      title: "Brand new tool",
      detail: "a: 1",
    });
  });

  test("plain tool messages still read", () => {
    expect(parseToolActivity("Edited a.ts")).toEqual({ kind: "other", title: "Edited a.ts" });
  });
});
