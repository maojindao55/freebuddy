import { open } from "node:fs/promises";
import { getDb } from "./db.js";
import { requireOwnedConversation } from "./conversations.js";
import { acpUpdateToItems, type AcpStreamItem } from "./acp.js";
import { getTask } from "./tasks.js";
import { restoreFileEditReferences } from "./fileEditBlobs.js";

export interface MessageDetailsPage {
  items?: AcpStreamItem[];
  available: boolean;
  text: string;
  nextOffset: number;
  hasMore: boolean;
}

/** Bounded random-access reads; never scan or load the entire run log. */
export async function readLogDetailsPage(path: string, offset = 0): Promise<MessageDetailsPage> {
  const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
  let file;
  try {
    file = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { available: false, text: "", nextOffset: start, hasMore: false };
    }
    throw error;
  }
  try {
    const { size } = await file.stat();
    const buffer = Buffer.alloc(128 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    let consumed = bytesRead;
    if (start + bytesRead < size) {
      const newline = buffer.subarray(0, bytesRead).lastIndexOf(10);
      if (newline >= 0) consumed = newline + 1;
      else {
        // Keep a UTF-8 character split across chunks for the next read.
        let lead = bytesRead - 1;
        while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--;
        if (lead >= 0) {
          const byte = buffer[lead]!;
          const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
          if (lead + width > bytesRead) consumed = lead;
        }
      }
    }
    return {
      available: true,
      text: buffer.subarray(0, consumed).toString("utf8"),
      nextOffset: start + consumed,
      hasMore: start + consumed < size
    };
  } finally {
    await file.close();
  }
}

export async function readMessageDetails(messageId: string, offset = 0): Promise<MessageDetailsPage> {
  const row = getDb().prepare(
    "SELECT conversation_id, task_id FROM conversation_messages WHERE id = ?"
  ).get(messageId) as { conversation_id: string; task_id: string | null } | undefined;
  if (!row || !requireOwnedConversation(row.conversation_id)) throw new Error("Message not available");
  const task = row.task_id ? getTask(row.task_id) : undefined;
  if (!task?.logPath) return { available: false, text: "", nextOffset: 0, hasMore: false };
  const page = await readLogDetailsPage(task.logPath, offset);
  const items = restoreLogItems(page.text);
  return { ...page, text: "", items: row.task_id
    ? restoreFileEditReferences({ conversationId: row.conversation_id, sessionId: row.task_id }, items)
    : items };
}

export function restoreLogItems(text: string): AcpStreamItem[] {
  const items: AcpStreamItem[] = [];
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== "stdout") continue;
      const event = JSON.parse(entry.content);
      if (event.method === "session/update") {
        items.push(...acpUpdateToItems(event.params?.update));
      }
    } catch { /* Incomplete or diagnostic log lines cannot be replayed. */ }
  }
  return items;
}
