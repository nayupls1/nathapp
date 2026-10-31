// The agent chat as a timeline (components/ChatTimeline.tsx): messages,
// runs of tool calls grouped and summed up, and where each turn ended.
import { parseToolActivity, type ChatMessage, type ToolActivity, type ToolKind } from "../../shared/api";

// --- Rows -------------------------------------------------------------------------------

export interface WorkEntry {
  id: number;
  activity: ToolActivity;
}

export type Row =
  | { type: "message"; message: ChatMessage }
  | { type: "work"; id: number; entries: WorkEntry[] }
  | { type: "turn-end"; id: number; ms: number; stopped: boolean };

/** Messages that come with your next message (they open a turn, before the `user` message itself). */
const opensTurn = (m: ChatMessage) => m.role === "user" || m.role === "context" || m.role === "attachments";

const STOPPED = "Stopped.";

/** The timeline's rows; the turn still running gets no end. */
export function buildRows(messages: readonly ChatMessage[], running: boolean, showTools: boolean): Row[] {
  const rows: Row[] = [];
  let turnStart: ChatMessage | null = null;
  let last: ChatMessage | null = null;
  let stopped = false;
  const endTurn = () => {
    if (turnStart && last && last !== turnStart) {
      rows.push({
        type: "turn-end",
        id: last.id,
        ms: Date.parse(last.createdAt) - Date.parse(turnStart.createdAt),
        stopped,
      });
    }
    turnStart = null;
    stopped = false;
  };
  for (const m of messages) {
    if (opensTurn(m) && last && !opensTurn(last)) endTurn();
    if (m.role === "user") turnStart = m;
    last = m;
    if (m.role === "error" && m.content === STOPPED) {
      stopped = true;
      continue;
    }
    if (m.role === "tool") {
      if (!showTools) continue;
      const entry = { id: m.id, activity: parseToolActivity(m.content) };
      const prev = rows.at(-1);
      if (prev?.type === "work") prev.entries.push(entry);
      else rows.push({ type: "work", id: m.id, entries: [entry] });
      continue;
    }
    rows.push({ type: "message", message: m });
  }
  if (!running) endTurn();
  return rows;
}

// --- Formatting ---------------------------------------------------------------------------

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "once" : `${n} times`);

/** "ran 2 commands" for a kind and a count. */
const kindPhrases: Record<ToolKind, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file", "files")}`,
  edit: (n) => `edited ${plural(n, "file", "files")}`,
  create: (n) => `created ${plural(n, "file", "files")}`,
  command: (n) => `ran ${plural(n, "command", "commands")}`,
  search: (n) => `searched ${times(n)}`,
  web: (n) => `used the web ${times(n)}`,
  page: (n) => `looked at the page ${times(n)}`,
  browse: (n) => `used the page ${times(n)}`,
  screenshot: (n) => `took ${plural(n, "screenshot", "screenshots")}`,
  inspect: (n) => `inspected the page ${times(n)}`,
  code: (n) => `ran ${plural(n, "script", "scripts")}`,
  performance: (n) => `measured ${times(n)}`,
  network: (n) => `checked the network ${times(n)}`,
  plan: () => "updated the plan",
  agent: (n) => `ran ${plural(n, "subagent", "subagents")}`,
  app: (n) => `worked on the app ${times(n)}`,
  customize: (n) => `customized ${times(n)}`,
  schedule: (n) => `changed schedules ${times(n)}`,
  snapshot: (n) => `used snapshots ${times(n)}`,
  secret: (n) => `handled ${plural(n, "secret", "secrets")}`,
  source: (n) => `used the attached code ${times(n)}`,
  tab: (n) => `looked at tabs ${times(n)}`,
  other: (n) => `used ${plural(n, "tool", "tools")}`,
};

const first: ToolKind[] = ["edit", "create", "command"];

/** "Edited 3 files, ran 2 commands and read 4 files": changes first, then in order of appearance; files counted once. */
export function summarize(entries: readonly WorkEntry[]): string {
  const counts = new Map<ToolKind, Set<string> | number>();
  for (const { activity } of entries) {
    const fileKind = activity.kind === "read" || activity.kind === "edit" || activity.kind === "create";
    const seen = counts.get(activity.kind) ?? (fileKind ? new Set<string>() : 0);
    counts.set(activity.kind, typeof seen === "number" ? seen + 1 : seen.add(activity.title));
  }
  // What changed things comes first.
  const order = (kind: ToolKind) => (first.includes(kind) ? first.indexOf(kind) : first.length);
  const parts = [...counts]
    .sort(([a], [b]) => order(a) - order(b))
    .map(([kind, n]) => kindPhrases[kind](typeof n === "number" ? n : n.size));
  const shown = parts.length > 3 ? [...parts.slice(0, 2), `${parts.length - 2} more`] : parts;
  const text = shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}` : shown[0]!;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
