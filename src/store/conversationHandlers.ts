import type { CliEvent } from "@/services/cli/types";
import type {
  CliStreamItem,
  ParseContext
} from "@/services/cli/parsers";
import { getParser } from "@/services/cli/parsers";
import { cliClient } from "@/services/cli/client";

import type { ConversationState } from "./conversationStore";
import { runCtxMap } from "./conversationStore";
import { appendItems } from "./conversationUtils";

type SetFn = (
  fn: (state: ConversationState) => Partial<ConversationState> | ConversationState
) => void;
type GetFn = () => ConversationState;

export function handleStreamEvent(
  set: SetFn,
  get: GetFn,
  conversationId: string,
  e: CliEvent,
  parser: ReturnType<typeof getParser>,
  parseCtx: ParseContext
): void {
  set((s) => {
    const live = s.live[conversationId];
    if (!live) return s;

    let nextItems = live.items;
    let status = live.status;
    let pid = live.pid;
    let exitCode = live.exitCode;
    let errorMessage = live.errorMessage;
    let capturedSessionId = live.capturedSessionId;

    if (e.type === "started") {
      status = "running";
      pid = e.pid;
    } else if (e.type === "stdout") {
      const items = parser.parseStdoutLine(e.content, parseCtx);
      nextItems = appendItems(nextItems, items);
      if (parseCtx.sessionId) capturedSessionId = parseCtx.sessionId;
    } else if (e.type === "stderr") {
      nextItems = appendItems(nextItems, [
        { kind: "command-output", content: e.content, stream: "stderr" }
      ] as CliStreamItem[]);
    } else if (e.type === "error") {
      nextItems = appendItems(nextItems, [
        { kind: "error", message: e.message }
      ] as CliStreamItem[]);
      errorMessage = e.message;
    } else if (e.type === "done") {
      // If the user already requested a stop, preserve "killed" status.
      if (status === "killed") {
        // keep status
      } else {
        status = e.exitCode === 0 ? "done" : "failed";
      }
      exitCode = e.exitCode;
      nextItems = appendItems(nextItems, [
        { kind: "done", exitCode: e.exitCode }
      ] as CliStreamItem[]);
    }

    // Mirror items into the assistant message snapshot in `messages`
    // so the renderer (which reads from messages) can show progressive output.
    const messageList = s.messages[conversationId] ?? [];
    const msgIdx = messageList.findIndex((m) => m.id === live.messageId);
    let messages = s.messages;
    if (msgIdx >= 0) {
      const updated = [...messageList];
      updated[msgIdx] = {
        ...updated[msgIdx],
        status,
        content: JSON.stringify(nextItems),
        updatedAt: new Date().toISOString()
      };
      messages = { ...s.messages, [conversationId]: updated };
    }

    return {
      live: {
        ...s.live,
        [conversationId]: {
          ...live,
          items: nextItems,
          status,
          pid,
          exitCode,
          errorMessage,
          capturedSessionId
        }
      },
      messages
    };
  });

  if (e.type === "done") {
    const live = get().live[conversationId];
    const reason = live?.status === "killed" ? "killed" : "done";
    void finalizeRun(set, get, conversationId, reason);
  }
}

async function finalizeRun(
  set: SetFn,
  get: GetFn,
  conversationId: string,
  reason: "done" | "killed"
): Promise<void> {
  const live = get().live[conversationId];
  if (!live) return;
  const finalStatus =
    reason === "killed"
      ? "killed"
      : live.exitCode === 0
        ? "done"
        : "failed";

  await cliClient.updateMessage({
    id: live.messageId,
    status: finalStatus,
    content: JSON.stringify(live.items)
  });

  const ctx = runCtxMap.get(live.taskSessionId);
  ctx?.unsubscribe();
  runCtxMap.delete(live.taskSessionId);

  set((s) => {
    const next = { ...s.live };
    delete next[conversationId];
    return { live: next };
  });
}

export async function killConversation(
  set: SetFn,
  get: GetFn,
  conversationId: string
): Promise<void> {
  const live = get().live[conversationId];
  if (!live) return;
  set((s) => ({
    live: {
      ...s.live,
      [conversationId]: { ...live, status: "killed" }
    }
  }));
  await cliClient.kill(live.taskSessionId);
  // The runtime will still emit a "done" event with exitCode != 0; finalizeRun
  // is called from handleStreamEvent on done, which will overwrite status using
  // exitCode. To preserve the killed status we rely on main marking the task
  // as killed in DB, but for in-memory state we want killed to stick. Override
  // by tagging it in the live snapshot which finalizeRun re-reads.
}
