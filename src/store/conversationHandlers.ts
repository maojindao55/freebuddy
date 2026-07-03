import i18next from "i18next";
import type { CliEvent } from "@/services/cli/types";
import type {
  CliStreamItem,
  ParseContext
} from "@/services/cli/parsers";
import { getParser } from "@/services/cli/parsers";
import { cliClient } from "@/services/cli/client";

import type { ConversationState } from "./conversationStore";
import { runCtxMap } from "./conversationStore";
import { usePermissionStore } from "./permissionStore";
import { appendItems } from "./conversationUtils";
import { latestSessionInfoFromMessages } from "./sessionMetaUtils";
import { useImagePreviewStore } from "./imagePreviewStore";
import { useTerminalStore } from "./terminalStore";
import { sanitizeStreamItems } from "@/utils/streamMedia";

type SetFn = (
  fn: (state: ConversationState) => Partial<ConversationState> | ConversationState
) => void;
type GetFn = () => ConversationState;

function sanitizeIncomingItems(items: CliStreamItem[]): CliStreamItem[] {
  return sanitizeStreamItems(items, (image) =>
    useImagePreviewStore.getState().register(image)
  );
}

function sessionTitleFromItems(items: CliStreamItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (
      item.kind === "session" &&
      typeof item.title === "string" &&
      item.title.trim().length > 0
    ) {
      return item.title.trim();
    }
  }
  return undefined;
}

function applyConversationTitle(
  conversations: ConversationState["conversations"],
  conversationId: string,
  title: string
): ConversationState["conversations"] {
  const conversation = conversations.find((entry) => entry.id === conversationId);
  if (!conversation || conversation.title === title) {
    return conversations;
  }
  void cliClient.renameConversation(conversationId, title);
  return conversations.map((entry) =>
    entry.id === conversationId ? { ...entry, title } : entry
  );
}

function isMetadataItem(item: CliStreamItem): boolean {
  return (
    item.kind === "session" ||
    item.kind === "available-commands" ||
    item.kind === "config-options" ||
    item.kind === "usage"
  );
}

function hasUserFacingError(items: CliStreamItem[]) {
  return items.some((item) => item.kind === "error");
}

function failureSummaryFor(exitCode: number, parseCtx: ParseContext): CliStreamItem {
  const details = parseCtx.diagnosticLogs?.slice(-30);
  return {
    kind: "error",
    message:
      exitCode === 130
        ? i18next.t("errors.agentInterrupted")
        : i18next.t("errors.agentFailed", {
            code: exitCode,
            detail: details?.length
              ? i18next.t("errors.rawLogCollapsed")
              : i18next.t("errors.cliNoStructured")
          }),
    details
  };
}

function refreshLatestErrorDetails(
  items: CliStreamItem[],
  parseCtx: ParseContext
): CliStreamItem[] {
  const details = parseCtx.diagnosticLogs?.slice(-30);
  if (!details?.length) return items;

  let errorIndex = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].kind === "error") {
      errorIndex = i;
      break;
    }
  }
  if (errorIndex < 0) return items;

  const next = [...items];
  const item = next[errorIndex];
  if (item.kind === "error") {
    next[errorIndex] = { ...item, details };
  }
  return next;
}

export function handleStreamEvent(
  set: SetFn,
  get: GetFn,
  conversationId: string,
  e: CliEvent,
  parser: ReturnType<typeof getParser>,
  parseCtx: ParseContext,
  preserveConversationTitle = false
): void {
  if (e.type === "permission") {
    usePermissionStore.getState().enqueue(conversationId, e.request);
    return;
  }
  if (e.type === "permission-resolved") {
    usePermissionStore.getState().remove(e.requestId);
    return;
  }

  set((s) => {
    const live = s.live[conversationId];
    if (!live) {
      if (e.type !== "items" || !e.items.some(isMetadataItem)) {
        return s;
      }

      const messageList = s.messages[conversationId] ?? [];
      const msgIdx = messageList.findLastIndex((m) => m.role === "assistant");
      if (msgIdx < 0) return s;

      const currentItems = (() => {
        try {
          const parsed = JSON.parse(messageList[msgIdx].content);
          return Array.isArray(parsed) ? (parsed as CliStreamItem[]) : [];
        } catch {
          return [];
        }
      })();
      const nextItems = appendItems(
        currentItems,
        sanitizeIncomingItems(e.items)
      );
      const updated = [...messageList];
      updated[msgIdx] = {
        ...updated[msgIdx],
        content: JSON.stringify(nextItems),
        updatedAt: new Date().toISOString()
      };

      const title = preserveConversationTitle ? undefined : sessionTitleFromItems(e.items);
      const conversations = title
        ? applyConversationTitle(s.conversations, conversationId, title)
        : s.conversations;

      void cliClient.updateMessage({
        id: updated[msgIdx].id,
        content: JSON.stringify(nextItems)
      });

      return {
        messages: { ...s.messages, [conversationId]: updated },
        conversations
      };
    }

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
      const items = sanitizeIncomingItems(parser.parseStdoutLine(e.content, parseCtx));
      nextItems = appendItems(nextItems, items);
      if (parseCtx.sessionId) capturedSessionId = parseCtx.sessionId;
    } else if (e.type === "stderr") {
      const items = sanitizeIncomingItems(
        parser.parseStderrLine?.(e.content, parseCtx) ?? [
          { kind: "command-output", content: e.content, stream: "stderr" }
        ]
      );
      nextItems = appendItems(nextItems, items as CliStreamItem[]);
      nextItems = refreshLatestErrorDetails(nextItems, parseCtx);
    } else if (e.type === "items") {
      nextItems = appendItems(nextItems, sanitizeIncomingItems(e.items));
      const sessionItem = [...e.items]
        .reverse()
        .find((item) => item.kind === "session");
      if (sessionItem?.kind === "session") {
        parseCtx.sessionId = sessionItem.sessionId;
        capturedSessionId = sessionItem.sessionId;
      }
    } else if (e.type === "terminal-update") {
      useTerminalStore.getState().upsert(e.terminalId, {
        output: e.output,
        truncated: e.truncated,
        exitCode: e.exitCode,
        exited: e.exited,
        running: e.running
      });
      nextItems = appendItems(nextItems, [
        {
          kind: "terminal-embed",
          terminalId: e.terminalId,
          output: e.output,
          truncated: e.truncated,
          exitCode: e.exitCode,
          exited: e.exited,
          running: e.running
        }
      ]);
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
      if (status !== "killed" && e.exitCode !== 0 && !hasUserFacingError(nextItems)) {
        nextItems = appendItems(nextItems, [failureSummaryFor(e.exitCode, parseCtx)]);
      }
      nextItems = appendItems(nextItems, [
        { kind: "done", exitCode: e.exitCode }
      ] as CliStreamItem[]);
    }

    // Mirror items into the assistant message snapshot in `messages`
    // so the renderer (which reads from messages) can show progressive output.
    const messageList = s.messages[conversationId] ?? [];
    const msgIdx = messageList.findIndex((m) => m.id === live.messageId);
    let messages = s.messages;
    let conversations = s.conversations;
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

    if (e.type === "items") {
      const title = sessionTitleFromItems(e.items);
      if (title && !live.preserveConversationTitle && !preserveConversationTitle) {
        conversations = applyConversationTitle(conversations, conversationId, title);
      }
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
      messages,
      conversations
    };
  });

  if (e.type === "done") {
    usePermissionStore.getState().removeForConversation(conversationId);
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
