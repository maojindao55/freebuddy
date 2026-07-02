import { memo, useMemo, useState, type MouseEvent } from "react";

import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import type { ChatAttachment, ConversationMessage } from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { appendItems } from "@/store/conversationUtils";
import { useImagePreviewStore } from "@/store/imagePreviewStore";
import { formatBytes, attachmentPreviewUrl } from "@/utils/chatAttachments";
import { sanitizeStreamItems } from "@/utils/streamMedia";
import { AgentAvatar } from "./AgentAvatar";
import { useImageLightbox } from "./ImageLightbox";
import { StreamItem, StreamToolInvocation } from "./StreamItem";
import { isVisibleItem, visibleBlocks } from "./messageBlocks";

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

function copyableItemText(item: CliStreamItem): string {
  if (item.kind === "text" || item.kind === "raw") return item.content;
  return "";
}

function messageText(message: ConversationMessage, items: CliStreamItem[]): string {
  if (message.role === "user" || message.role === "system") return message.content;
  return items.map(copyableItemText).filter(Boolean).join("\n\n");
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
                event.currentTarget.hidden = true;
                const fallback = event.currentTarget.nextElementSibling;
                if (fallback instanceof HTMLElement) {
                  fallback.hidden = false;
                }
              }}
            />
            <span className="message-image-fallback" hidden>
              {attachment.name}
            </span>
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

export const MessageBubble = memo(function MessageBubble({
  message,
  adapter,
  blockLimit,
  typingChars
}: {
  message: ConversationMessage;
  adapter?: string;
  blockLimit?: number;
  typingChars?: number;
}) {
  const { t } = useTranslation();
  const items = useMemo<CliStreamItem[]>(() => {
    if (message.role !== "assistant") return [];
    try {
      const parsed = JSON.parse(message.content);
      const base = Array.isArray(parsed)
        ? parsed
        : [{ kind: "raw", content: message.content } satisfies CliStreamItem];
      return normalizeStoredItems(
        sanitizeStreamItems(base as CliStreamItem[], (image) =>
          useImagePreviewStore.getState().register(image)
        )
      );
    } catch {
      return normalizeStoredItems(
        sanitizeStreamItems([{ kind: "raw", content: message.content }], (image) =>
          useImagePreviewStore.getState().register(image)
        )
      );
    }
  }, [message.role, message.content]);
  const visibleItems = useMemo(() => {
    const hideDiagnosticStderr = items.some(
      (item) => item.kind === "error" && Boolean(item.details?.length)
    );
    return items.filter((item) => isVisibleItem(item, hideDiagnosticStderr));
  }, [items]);
  const blocks = useMemo(() => visibleBlocks(visibleItems), [visibleItems]);
  const renderedBlocks = useMemo(() => {
    const sliced = blockLimit != null ? blocks.slice(0, blockLimit) : blocks;
    if (typingChars == null || sliced.length === 0) return sliced;
    const lastIdx = sliced.length - 1;
    const last = sliced[lastIdx];
    if (
      last.kind === "single" &&
      (last.item.kind === "text" || last.item.kind === "raw")
    ) {
      const next = sliced.slice();
      next[lastIdx] = {
        ...last,
        item: {
          ...last.item,
          content: (last.item.content ?? "").slice(0, typingChars)
        }
      };
      return next;
    }
    return sliced;
  }, [blocks, blockLimit, typingChars]);
  const isWaitingForAgent =
    message.role === "assistant" &&
    (message.status === "running" || message.status === "starting") &&
    renderedBlocks.length === 0;

  const timeStr = useMemo(() => {
    try {
      const d = new Date(message.createdAt);
      return d.toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      });
    } catch {
      return "";
    }
  }, [message.createdAt]);
  const [copyMenu, setCopyMenu] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const copyText = messageText(message, items).trim();
  const showActionBar = message.role === "assistant" && message.status === "done" && Boolean(copyText);
  const getSelectionText = () => {
    const sel = window.getSelection();
    return sel && sel.toString().trim().length > 0 ? sel.toString().trim() : "";
  };
  const handleContextMenu = (event: MouseEvent) => {
    if (!copyText) return;
    event.preventDefault();
    setCopyMenu({ x: event.clientX, y: event.clientY });
  };
  const doCopy = (text: string) => {
    if (text) void navigator.clipboard?.writeText(text);
    setCopyMenu(null);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  const copyMenuNode = copyMenu ? (() => {
    const sel = getSelectionText();
    return (
      <div
        className="message-context-menu"
        style={{ left: copyMenu.x, top: copyMenu.y }}
        onMouseLeave={() => setCopyMenu(null)}
      >
        {sel && (
          <button type="button" onClick={() => doCopy(sel)}>
            {t("message.copySelection")}
          </button>
        )}
        <button type="button" onClick={() => doCopy(copyText)}>
          {t("message.copy")}
        </button>
      </div>
    );
  })() : null;
  const actionBarNode = showActionBar ? (
    <div className="msg-actions">
      <button
        type="button"
        className={`msg-action-btn${copied ? " copied" : ""}`}
        onClick={() => doCopy(copyText)}
        title={t("message.copy")}
        aria-label={t("message.copy")}
      >
        {copied ? (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="msg-action-icon">
            <path d="M20 6 9 17l-5-5" />
          </svg>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="msg-action-icon">
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" />
          </svg>
        )}
      </button>
      <button
        type="button"
        className={`msg-action-btn${vote === "up" ? " active up" : ""}`}
        onClick={() => setVote((v) => (v === "up" ? null : "up"))}
        title={t("message.upvote")}
        aria-label={t("message.upvote")}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="msg-action-icon">
          <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3H14Z" />
          <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
        </svg>
      </button>
      <button
        type="button"
        className={`msg-action-btn${vote === "down" ? " active down" : ""}`}
        onClick={() => setVote((v) => (v === "down" ? null : "down"))}
        title={t("message.downvote")}
        aria-label={t("message.downvote")}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="msg-action-icon">
          <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.7a2 2 0 0 0-2 1.7l-1.4 9A2 2 0 0 0 4.3 15H10Z" />
          <path d="M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3" />
        </svg>
      </button>
      {timeStr && <span className="msg-action-time">{timeStr}</span>}
    </div>
  ) : null;

  if (message.role === "user") {
    const { images: imageAttachments, others: otherAttachments } =
      partitionAttachments(message.attachments);
    const hasText = message.content.trim().length > 0;
    const hasOthers = otherAttachments.length > 0;
    const showBubble = hasText || hasOthers;

    return (
      <div className="msg msg-user">
        <div className="msg-content-wrapper" onContextMenu={handleContextMenu}>
          <div className="msg-header">
            <span className="msg-author">{t("message.you")}</span>
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
          {copyMenuNode}
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
      <div className="msg msg-system msg-system-divider" onContextMenu={handleContextMenu}>
        <span className="msg-system-divider-line" aria-hidden="true" />
        <span className="msg-system-divider-label">
          <span className="msg-system-role">{label}</span>
          {message.agentName && (
            <span className="msg-system-agent">{message.agentName}</span>
          )}
        </span>
        <span className="msg-system-divider-line" aria-hidden="true" />
        {copyMenuNode}
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
      <div className="msg-content-wrapper" onContextMenu={handleContextMenu}>
        <div className="msg-header">
          <span className="msg-author">{agentLabel}</span>
          {(roleLabel || statusText) && (
            <span className={`status-pill ${message.status}`}>
              {roleLabel && (
                <span className="status-pill-role">{roleLabel}</span>
              )}
              {statusText && <span>{statusText}</span>}
            </span>
          )}
        </div>
        {renderedBlocks.length > 0 && (
          <div className="msg-bubble">
            <div className="msg-items">
              {renderedBlocks.map((block, i) => (
                block.kind === "tool" ? (
                  <StreamToolInvocation
                    key={i}
                    call={block.call}
                    results={block.results}
                    commands={block.commands}
                    extras={block.extras}
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
        {actionBarNode}
        {copyMenuNode}
      </div>
    </div>
  );
});
