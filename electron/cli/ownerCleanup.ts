import fs from "node:fs";
import { getDb } from "./db.js";
import { getLogDir } from "./db.js";
import { deleteConversation } from "./conversations.js";
import { deleteScheduledTask } from "./scheduledTasks.js";
import { removeRemoteWorkspacesForUser } from "./remoteWorkspaces.js";
import { isPathWithinRoots } from "../shared/workspaceRoots.js";
import type { UserDataFootprint } from "./users.js";

/**
 * Removes everything a remote account owns before the account row goes away.
 *
 * The per-record helpers are used deliberately: `deleteConversation` also
 * releases managed attachment files, and `deleteScheduledTask` refuses to drop
 * a task that is mid-run and notifies subscribers.
 */
export function deleteUserOwnedData(userId: string): UserDataFootprint {
  const db = getDb();
  const conversationIds = (
    db
      .prepare("SELECT id FROM conversations WHERE owner_id = ?")
      .all(userId) as Array<{ id: string }>
  ).map((row) => row.id);
  const taskIds = (
    db
      .prepare("SELECT id FROM scheduled_tasks WHERE owner_id = ?")
      .all(userId) as Array<{ id: string }>
  ).map((row) => row.id);

  let scheduledTasks = 0;
  for (const id of taskIds) {
    if (deleteScheduledTask(id)) scheduledTasks += 1;
  }
  for (const id of conversationIds) {
    deleteConversation(id);
  }
  const taskLogs = db
    .prepare(
      "SELECT log_path FROM cli_tasks WHERE owner_id = ? AND log_path IS NOT NULL"
    )
    .all(userId) as Array<{ log_path: string }>;
  for (const row of taskLogs) {
    if (isPathWithinRoots(row.log_path, [getLogDir()])) {
      fs.rmSync(row.log_path, { force: true });
    }
  }
  db.prepare("DELETE FROM cli_tasks WHERE owner_id = ?").run(userId);
  db.prepare("DELETE FROM cli_tool_sessions WHERE owner_id = ?").run(userId);
  removeRemoteWorkspacesForUser(userId);
  return { conversations: conversationIds.length, scheduledTasks };
}
