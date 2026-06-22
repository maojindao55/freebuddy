import { useMemo } from "react";

import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import type { ChatAttachment, ConversationMessage } from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { appendItems } from "@/store/conversationUtils";
import { formatBytes, attachmentPreviewUrl } from "@/utils/chatAttachments";
import { AgentAvatar } from "./AgentAvatar";
import { useImageLightbox } from "./ImageLightbox";
import { StreamItem, StreamToolInvocation } from "./StreamItem";

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

export function normalizeStoredItems(items: CliStreamItem[]): CliStreamItem[] {
  let out: CliStreamItem[] = [];

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
      out = appendItems(out, [next]);
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
  return item.kind !== "session" && item.kind !== "usage" && item.kind !== "plan";
}

type VisibleBlock =
  | { kind: "single"; item: CliStreamItem }
  | {
      kind: "tool";
      call: Extract<CliStreamItem, { kind: "tool-call" }>;
      results: Extract<CliStreamItem, { kind: "tool-result" }>[];
      commands: Extract<CliStreamItem, { kind: "command" }>[];
    };

function sameToolInvocation(
  call: Extract<CliStreamItem, { kind: "tool-call" }>,
  result: Extract<CliStreamItem, { kind: "tool-result" }>
) {
  if (call.id || result.id) return call.id === result.id;
  return true;
}

function visibleBlocks(items: CliStreamItem[]): VisibleBlock[] {
  const blocks: VisibleBlock[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item.kind !== "tool-call") {
      blocks.push({ kind: "single", item });
      continue;
    }

    const results: Extract<CliStreamItem, { kind: "tool-result" }>[] = [];
    const commands: Extract<CliStreamItem, { kind: "command" }>[] = [];
    let cursor = i + 1;
    while (cursor < items.length) {
      const next = items[cursor];
      if (next.kind !== "tool-result" && next.kind !== "command") break;
      if (next.kind === "tool-result") {
        if (!sameToolInvocation(item, next)) break;
        results.push(next);
      } else {
        commands.push(next);
      }
      cursor += 1;
    }
    blocks.push({ kind: "tool", call: item, results, commands });
    i = cursor - 1;
  }

  return blocks;
}

function attachmentSummary(attachment: ChatAttachment): string {
  return [
    attachment.mimeType || attachment.extension || attachment.kind,
    typeof attachment.size === "number" ? formatBytes(attachment.size) : ""
  ]
    .filter(Boolean)
    .join(" - ");
}

function partitionAttachments(attachments?: ChatAttachment[]): {
  images: ChatAttachment[];
  others: ChatAttachment[];
} {
  const images: ChatAttachment[] = [];
  const others: ChatAttachment[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.kind === "image") {
      images.push(attachment);
    } else {
      others.push(attachment);
    }
  }
  return { images, others };
}

function MessageImageAttachments({
  attachments
}: {
  attachments: ChatAttachment[];
}) {
  const { t } = useTranslation();
  const { open } = useImageLightbox();
  if (!attachments.length) return null;

  return (
    <div
      className="message-image-attachments"
      aria-label={t("attachments.imagesAria")}
    >
      {attachments.map((attachment) => {
        const src = attachmentPreviewUrl(attachment.path);
        return (
          <button
            key={attachment.id}
            type="button"
            className="message-image-attachment"
            title={attachment.path}
            aria-label={t("attachments.previewName", { name: attachment.name })}
            onClick={() => open({ src, alt: attachment.name })}
          >
            <img
              src={src}
              alt={attachment.name}
              loading="lazy"
              onError={(event) => {
                const button = event.currentTarget.closest(
                  ".message-image-attachment"
                ) as HTMLElement | null;
                if (button) button.style.display = "none";
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function MessageAttachments({
  attachments
}: {
  attachments?: ChatAttachment[];
}) {
  const { t } = useTranslation();
  const { open } = useImageLightbox();
  if (!attachments?.length) return null;

  return (
    <div className="message-attachments attachment-list" aria-label={t("attachments.listAria")}>
      {attachments.map((attachment) => {
        const isImage = attachment.kind === "image";
        const previewSrc = isImage ? attachmentPreviewUrl(attachment.path) : null;
        const thumb = (
          <span className="message-attachment-thumb" aria-hidden={!isImage}>
            {isImage && previewSrc ? (
              <img
                src={previewSrc}
                alt=""
                loading="lazy"
                className="message-attachment-thumb-img"
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                  const sibling = event.currentTarget
                    .nextElementSibling as HTMLElement | null;
                  if (sibling) sibling.style.display = "flex";
                }}
              />
            ) : null}
            <span
              className="message-attachment-kind"
              style={isImage ? { display: "none" } : undefined}
            >
              {isImage
                ? t("attachments.kindImage")
                : attachment.kind === "code"
                  ? t("attachments.kindCode")
                  : t("attachments.kindFile")}
            </span>
          </span>
        );
        return (
          <div className="message-attachment" key={attachment.id} title={attachment.path}>
            {isImage && previewSrc ? (
              <button
                type="button"
                className="message-attachment-thumb-button"
                onClick={() => open({ src: previewSrc, alt: attachment.name })}
                aria-label={t("attachments.previewName", { name: attachment.name })}
              >
                {thumb}
              </button>
            ) : (
              thumb
            )}
            <span className="message-attachment-main">
              <span className="message-attachment-name">{attachment.name}</span>
              <span className="message-attachment-meta">
                {attachmentSummary(attachment)}
              </span>
              <span className="message-attachment-path">{attachment.path}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MessageBubble({
  message,
  adapter
}: {
  message: ConversationMessage;
  adapter?: string;
}) {
  const { t } = useTranslation();
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
  const blocks = useMemo(() => visibleBlocks(visibleItems), [visibleItems]);
  const isWaitingForAgent =
    message.role === "assistant" &&
    (message.status === "running" || message.status === "starting") &&
    blocks.length === 0;

  const timeStr = useMemo(() => {
    try {
      const d = new Date(message.createdAt);
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch {
      return "";
    }
  }, [message.createdAt]);

  if (message.role === "user") {
    const { images: imageAttachments, others: otherAttachments } =
      partitionAttachments(message.attachments);
    const hasText = message.content.trim().length > 0;
    const hasOthers = otherAttachments.length > 0;
    const showBubble = hasText || hasOthers;

    return (
      <div className="msg msg-user">
        <div className="msg-content-wrapper">
          <div className="msg-header">
            <span className="msg-author">{t("message.you")}</span>
            <span className="msg-time">{timeStr}</span>
          </div>
          {showBubble && (
            <div className="msg-bubble">
              {hasText && <pre>{message.content}</pre>}
              <MessageAttachments attachments={otherAttachments} />
            </div>
          )}
          {imageAttachments.length > 0 && (
            <MessageImageAttachments attachments={imageAttachments} />
          )}
        </div>
        <div className="msg-avatar user-avatar">
          <span>👤</span>
        </div>
      </div>
    );
  }

  if (message.role === "system") {
    const label = message.roleLabel ?? t("message.system");
    return (
      <div className="msg msg-system msg-system-divider">
        <span className="msg-system-divider-line" aria-hidden="true" />
        <span className="msg-system-divider-label">
          <span className="msg-system-role">{label}</span>
          {message.agentName && (
            <span className="msg-system-agent">{message.agentName}</span>
          )}
        </span>
        <span className="msg-system-divider-line" aria-hidden="true" />
      </div>
    );
  }

  const roleLabel = message.roleLabel;
  const agentLabel = message.agentName ?? displayAgentName(undefined, adapter);
  const statusText =
    message.status !== "ready" ? t(`status.${message.status}`) : null;

  return (
    <div className="msg msg-assistant">
      <AgentAvatar
        adapter={message.adapter ?? adapter}
        className="msg-avatar agent-avatar"
        fallback={<span>✦</span>}
      />
      <div className="msg-content-wrapper">
        <div className="msg-header">
          <span className="msg-author">{agentLabel}</span>
          <span className="msg-time">{timeStr}</span>
          {(roleLabel || statusText) && (
            <span className={`status-pill ${message.status}`}>
              {roleLabel && (
                <span className="status-pill-role">{roleLabel}</span>
              )}
              {statusText && <span>{statusText}</span>}
            </span>
          )}
        </div>
        {blocks.length > 0 && (
          <div className="msg-bubble">
            <div className="msg-items">
              {blocks.map((block, i) => (
                block.kind === "tool" ? (
                  <StreamToolInvocation
                    key={i}
                    call={block.call}
                    results={block.results}
                    commands={block.commands}
                  />
                ) : (
                  <StreamItem key={i} item={block.item} />
                )
              ))}
            </div>
          </div>
        )}
        {isWaitingForAgent && (
          <div className="msg-loading">
            <span className="loading-dots">●●●</span>
            <span>{t("message.thinking")}</span>
          </div>
        )}
      </div>
    </div>
  );
}
