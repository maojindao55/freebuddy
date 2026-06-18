import { useMemo } from "react";

import type { ConversationMessage } from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { StreamItem } from "./StreamItem";

const HIDDEN_CODEX_EVENTS = new Set([
  "thread.started",
  "turn.started",
  "item.started",
  "item.updated",
  "turn.completed"
]);

function errorMessageFrom(value: any, fallback: string): string {
  const err = value?.error;
  if (typeof err === "string") return err;
  if (err?.message) return String(err.message);
  if (value?.message) return String(value.message);
  return fallback;
}

function normalizeRawItem(item: Extract<CliStreamItem, { kind: "raw" }>): CliStreamItem[] {
  try {
    const obj = JSON.parse(item.content);
    const msg = obj.msg ?? obj;
    const rawType = msg.type ?? obj.type;
    const type = rawType == null ? "" : String(rawType);

    if (type === "item.completed") {
      const completed = msg.item ?? {};
      const completedType = String(completed.type ?? "");
      const text = completed.text ?? completed.message ?? completed.content;

      if (
        (completedType === "agent_message" ||
          completedType === "assistant_message") &&
        text
      ) {
        return [
          {
            kind: "text",
            role: "assistant",
            content: String(text)
          }
        ];
      }

      if (completedType === "reasoning" && text) {
        return [{ kind: "thinking", content: String(text) }];
      }

      if (completedType === "function_call" || completedType === "tool_call") {
        return [
          {
            kind: "tool-call",
            tool: String(completed.name ?? completed.tool ?? "tool"),
            input: completed.arguments ?? completed.input,
            id: completed.id
          }
        ];
      }

      if (
        completedType === "function_call_output" ||
        completedType === "tool_result"
      ) {
        return [
          {
            kind: "tool-result",
            tool: String(completed.name ?? completed.tool ?? "tool"),
            id: completed.id,
            content: String(completed.output ?? completed.content ?? ""),
            isError: completed.is_error === true
          }
        ];
      }

      return [];
    }

    if (type === "turn.completed" && msg.usage) {
      return [
        {
          kind: "usage",
          inputTokens: msg.usage.input_tokens ?? msg.usage.inputTokens,
          outputTokens: msg.usage.output_tokens ?? msg.usage.outputTokens,
          totalCost: msg.usage.total_cost ?? msg.usage.totalCost
        }
      ];
    }

    if (
      type === "turn.failed" ||
      type === "turn.error" ||
      type === "turn.aborted" ||
      type === "turn.cancelled" ||
      type === "error"
    ) {
      return [
        {
          kind: "error",
          message: errorMessageFrom(msg, item.content)
        }
      ];
    }

    if (HIDDEN_CODEX_EVENTS.has(type)) return [];

    if (type) return [];
  } catch {
    // Keep non-JSON raw content visible.
  }

  return [item];
}

function normalizeStoredItems(items: CliStreamItem[]): CliStreamItem[] {
  const out: CliStreamItem[] = [];

  for (const item of items) {
    const normalized = item.kind === "raw" ? normalizeRawItem(item) : [item];

    for (const next of normalized) {
      const last = out[out.length - 1];
      if (
        next.kind === "error" &&
        last?.kind === "error" &&
        last.message === next.message
      ) {
        continue;
      }
      out.push(next);
    }
  }

  return out;
}

function isVisibleItem(item: CliStreamItem, hideDiagnosticStderr = false) {
  if (
    hideDiagnosticStderr &&
    item.kind === "command-output" &&
    item.stream === "stderr"
  ) {
    return false;
  }
  return item.kind !== "session";
}

export function MessageBubble({ message }: { message: ConversationMessage }) {
  const items = useMemo<CliStreamItem[]>(() => {
    if (message.role !== "assistant") return [];
    try {
      const parsed = JSON.parse(message.content);
      return Array.isArray(parsed)
        ? normalizeStoredItems(parsed)
        : normalizeStoredItems([{ kind: "raw", content: message.content }]);
    } catch {
      return [{ kind: "raw", content: message.content }];
    }
  }, [message.role, message.content]);
  const visibleItems = useMemo(() => {
    const hideDiagnosticStderr = items.some(
      (item) => item.kind === "error" && Boolean(item.details?.length)
    );
    return items.filter((item) => isVisibleItem(item, hideDiagnosticStderr));
  }, [items]);
  const isWaitingForAgent =
    message.role === "assistant" &&
    (message.status === "running" || message.status === "starting") &&
    visibleItems.length === 0;

  const timeStr = useMemo(() => {
    try {
      const d = new Date(message.createdAt);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return "";
    }
  }, [message.createdAt]);

  if (message.role === "user") {
    return (
      <div className="msg msg-user">
        <div className="msg-content-wrapper">
          <div className="msg-header">
            <span className="msg-author">You</span>
            <span className="msg-time">{timeStr}</span>
          </div>
          <div className="msg-bubble">
            <pre>{message.content}</pre>
          </div>
        </div>
        <div className="msg-avatar user-avatar">
          <span>👤</span>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg-assistant">
      <div className="msg-avatar agent-avatar">
        <span>✦</span>
      </div>
      <div className="msg-content-wrapper">
        <div className="msg-header">
          <span className="msg-author">Agent</span>
          <span className="msg-time">{timeStr}</span>
          {message.status !== "ready" && (
            <span className={`status-pill ${message.status}`}>
              {message.status}
            </span>
          )}
        </div>
        {visibleItems.length > 0 && (
          <div className="msg-bubble">
            <div className="msg-items">
              {visibleItems.map((it, i) => (
                <StreamItem key={i} item={it} />
              ))}
            </div>
          </div>
        )}
        {isWaitingForAgent && (
          <div className="msg-loading">
            <span className="loading-dots">●●●</span>
            <span>正在思考</span>
          </div>
        )}
      </div>
    </div>
  );
}
