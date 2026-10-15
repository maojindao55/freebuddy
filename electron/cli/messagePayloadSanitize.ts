import type { ConversationMessage } from "./conversations.js";
import {
  MAX_IPC_LIST_MESSAGES_CHARS,
  OMITTED_ASSISTANT_CONTENT,
  sanitizeMessageContent
} from "@freebuddy/cli-stream";

export {
  MAX_IPC_MESSAGE_CONTENT_CHARS,
  MAX_IPC_LIST_MESSAGES_CHARS,
  IPC_LIST_MESSAGES_PAGE_SIZE,
  IPC_LIST_MESSAGES_PAGE_CHARS,
  OMITTED_ASSISTANT_CONTENT,
  sanitizeMessageContent,
  serializeStreamItemsForPersist
} from "@freebuddy/cli-stream";

export function sanitizeMessageForIpc(
  message: ConversationMessage
): ConversationMessage {
  const content = sanitizeMessageContent(message.content, message.role);
  if (content === message.content) return message;
  return { ...message, content };
}

export function sanitizeMessagesForIpc(
  messages: ConversationMessage[]
): ConversationMessage[] {
  const sanitized = messages.map(sanitizeMessageForIpc);
  let budget = MAX_IPC_LIST_MESSAGES_CHARS;
  const out = new Array<ConversationMessage>(sanitized.length);
  for (let index = sanitized.length - 1; index >= 0; index -= 1) {
    const entry = sanitized[index];
    const size = entry.content.length;
    if (size <= budget) {
      out[index] = entry;
      budget -= size;
      continue;
    }
    out[index] = {
      ...entry,
      content: entry.role === "assistant"
        ? OMITTED_ASSISTANT_CONTENT : "… [message omitted: too large to load] …"
    };
    budget = Math.max(0, budget - out[index].content.length);
  }
  return out;
}
