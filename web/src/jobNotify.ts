// Which notifications to show for jobs that just ended (the jobs tray's list, Jobs.tsx). No browser imports.
import type { HistoryEntry } from "./jobHistory.ts";

export interface NotifyContext {
  /** the page is hidden: another tab, the app in the background, the window minimised */
  hidden: boolean;
  /** the Settings switch */
  enabled: boolean;
  /** Notification.permission, or "unsupported" */
  permission: string;
}

export interface JobNotification {
  title: string;
  body: string;
  tag: string;
}

const line = (e: HistoryEntry) => `${e.title} ${e.outcome === "failed" ? "failed" : "finished"}`;

/**
 * Nothing while the page is shown (the tray says it), with the switch off or without permission. Cancelled jobs are
 * left out: the user did that. One job: its title and detail line. Several: one notification that counts them.
 */
export function notificationsFor(ended: HistoryEntry[], ctx: NotifyContext): JobNotification[] {
  if (!ctx.hidden || !ctx.enabled || ctx.permission !== "granted") return [];
  const list = ended.filter((e) => e.outcome !== "canceled");
  if (list.length === 0) return [];
  if (list.length === 1) {
    const e = list[0] as HistoryEntry;
    return [{ title: line(e), body: e.detail ?? "", tag: `filedeck-job:${e.key}` }];
  }
  const failed = list.filter((e) => e.outcome === "failed").length;
  return [{ title: failed ? `${list.length} jobs ended, ${failed} failed` : `${list.length} jobs finished`, body: list.map(line).join("\n"), tag: "filedeck-jobs" }];
}
