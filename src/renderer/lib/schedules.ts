// Notifications for background runs: a notice in Rune Browser, and a system
// notification when Rune Browser isn't focused (never when rendering offscreen).
import { topics } from "../../shared/hub";
import { toast } from "../components/Toast";
import { watchTopic } from "./realtime";

const titles: Record<string, string> = { ok: "Finished", error: "Failed", timeout: "Timed out", skipped: "Skipped" };

watchTopic(topics.schedules, (msg) => {
  if (msg.type !== "schedule-run" || !msg.notify) return;
  const { run } = msg;
  const title = `${run.scheduleName}: ${titles[run.status] ?? run.status}`;
  toast({ title, message: run.message || "Done", kind: run.status === "ok" ? "success" : "error" });
  if (window.rune.offscreen || document.hasFocus() || typeof Notification === "undefined") return;
  try {
    new Notification(title, { body: run.message, silent: run.status === "ok" });
  } catch {
    // not supported here
  }
});
