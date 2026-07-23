import {
  Brain,
  Check,
  Copy,
  FileText,
  LoaderCircle,
  Package,
  Search,
  SquarePen,
  SquareTerminal,
  ThumbsDown,
  ThumbsUp,
  Wrench,
  type LucideIcon
} from "lucide-react";
import { memo, useCallback, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";

import { useTranslation } from "react-i18next";

import { displayAgentName } from "@/config/agentDisplay";
import type { ChatAttachment, ConversationMessage } from "@/services/cli/types";
import type { CliStreamItem } from "@/services/cli/parsers";
import { appendItems } from "@/store/conversationUtils";
import { useImagePreviewStore } from "@/store/imagePreviewStore";
import { splitAutolinkSegments } from "@/utils/autolink";
import { formatBytes, attachmentPreviewUrl } from "@/utils/chatAttachments";
import { splitWorkspaceFileMentions } from "@/utils/workspaceFileMentions";
import { pluginDisplayName, splitPluginMentions } from "@/utils/pluginMentions";
import { sanitizeStreamItems } from "@/utils/streamMedia";
import { AgentAvatar } from "./AgentAvatar";
import { useImageLightbox } from "./ImageLightbox";
import { StreamItem, StreamToolInvocation } from "./StreamItem";
import { isVisibleItem, visibleBlocks } from "./messageBlocks";
import { useWhipEffectStore, type WhipTargetPoint } from "@/store/whipEffectStore";

type MessageBlock = ReturnType<typeof visibleBlocks>[number];
type MessageSection =
  | { kind: "block"; block: MessageBlock }
  | { kind: "process"; blocks: MessageBlock[] };
type Translate = ReturnType<typeof useTranslation>["t"];
type ProcessActivityKind =
  | "edit"
  | "command"
  | "read"
  | "search"
  | "thinking"
  | "tool";
type ProcessActivityCounts = Record<ProcessActivityKind, number>;
interface ProcessOutcomeCounts {
  succeeded: number;
  failed: number;
}

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

function emptyActivityCounts(): ProcessActivityCounts {
  return {
    edit: 0,
    command: 0,
    read: 0,
    search: 0,
    thinking: 0,
    tool: 0
  };
}

function addActivityCounts(
  target: ProcessActivityCounts,
  source: ProcessActivityCounts
) {
  target.edit += source.edit;
  target.command += source.command;
  target.read += source.read;
  target.search += source.search;
  target.thinking += source.thinking;
  target.tool += source.tool;
}

function countSingleActivity(
  item: CliStreamItem,
  counts: ProcessActivityCounts
) {
  switch (item.kind) {
    case "thinking":
      counts.thinking += 1;
      break;
    case "tool-call":
      switch (item.toolKind) {
        case "edit":
        case "delete":
        case "move":
          counts.edit += Math.max(1, countNestedActivity(item.toolOutputs ?? []).edit);
          break;
        case "execute":
          counts.command += Math.max(
            1,
            countNestedActivity(item.toolOutputs ?? []).command
          );
          break;
        case "read":
          counts.read += 1;
          addActivityCounts(counts, countNestedActivity(item.toolOutputs ?? []));
          break;
        case "search":
        case "fetch":
          counts.search += 1;
          addActivityCounts(counts, countNestedActivity(item.toolOutputs ?? []));
          break;
        case "think":
          counts.thinking += 1;
          addActivityCounts(counts, countNestedActivity(item.toolOutputs ?? []));
          break;
        default:
          counts.tool += 1;
          addActivityCounts(counts, countNestedActivity(item.toolOutputs ?? []));
          break;
      }
      break;
    case "command":
    case "terminal-embed":
      counts.command += 1;
      break;
    case "file-edit":
      counts.edit += 1;
      break;
    case "command-output":
    case "tool-result":
      counts.tool += 1;
      break;
    default:
      break;
  }
}

function countNestedActivity(items: CliStreamItem[]): ProcessActivityCounts {
  const counts = emptyActivityCounts();
  for (const item of items) countSingleActivity(item, counts);
  return counts;
}

function countProcessActivity(blocks: MessageBlock[]): ProcessActivityCounts {
  const counts = emptyActivityCounts();
  for (const block of blocks) {
    if (block.kind === "single") {
      countSingleActivity(block.item, counts);
      continue;
    }

    const nested = countNestedActivity(block.extras);
    const commandCount = block.commands.length + nested.command;
    switch (block.call.toolKind) {
      case "edit":
      case "delete":
      case "move":
        counts.edit += Math.max(1, nested.edit);
        break;
      case "execute":
        counts.command += Math.max(1, commandCount);
        break;
      case "read":
        counts.read += 1;
        break;
      case "search":
      case "fetch":
        counts.search += 1;
        break;
      case "think":
        counts.thinking += 1;
        break;
      default:
        counts.tool += 1;
        break;
    }
    counts.edit += block.call.toolKind === "edit" ? 0 : nested.edit;
    counts.command += block.call.toolKind === "execute" ? 0 : commandCount;
    counts.read += nested.read;
    counts.search += nested.search;
    counts.thinking += nested.thinking;
    counts.tool += nested.tool;
  }
  return counts;
}

function activityLabel(kind: ProcessActivityKind, count: number, t: Translate) {
  switch (kind) {
    case "edit":
      return t("stream.activityEditedFiles", { count });
    case "command":
      return t("stream.activityRanCommands", { count });
    case "read":
      return t("stream.activityReadFiles", { count });
    case "search":
      return t("stream.activitySearched", { count });
    case "thinking":
      return t("stream.activityAnalyzed", { count });
    case "tool":
      return t("stream.activityUsedTools", { count });
  }
}

function formatActivitySummary(
  counts: ProcessActivityCounts,
  blockCount: number,
  t: Translate
) {
  const parts: string[] = [];
  const order: ProcessActivityKind[] = [
    "edit",
    "command",
    "read",
    "search",
    "thinking",
    "tool"
  ];
  for (const kind of order) {
    const count = counts[kind];
    if (count > 0) parts.push(activityLabel(kind, count, t));
  }
  return parts.length > 0
    ? parts.join(" ")
    : t("stream.activityProcessed", { count: blockCount });
}

function dominantActivityIcon(
  counts: ProcessActivityCounts,
  hasRunning: boolean
): LucideIcon {
  if (
    hasRunning &&
    counts.edit === 0 &&
    counts.command === 0 &&
    counts.read === 0 &&
    counts.search === 0 &&
    counts.thinking === 0
  ) {
    return LoaderCircle;
  }
  if (counts.edit > 0) return SquarePen;
  if (counts.command > 0) return SquareTerminal;
  if (counts.read > 0) return FileText;
  if (counts.search > 0) return Search;
  if (counts.thinking > 0) return Brain;
  return Wrench;
}

function isProcessBlock(block: MessageBlock): boolean {
  if (block.kind === "tool") return true;
  switch (block.item.kind) {
    case "thinking":
    case "tool-call":
    case "tool-result":
    case "command":
    case "command-output":
    case "file-edit":
    case "terminal-embed":
      return true;
    default:
      return false;
  }
}

function blockHasIssue(block: MessageBlock): boolean {
  if (block.kind === "tool") {
    return (
      block.call.isError === true ||
      block.call.status === "failed" ||
      block.results.some((result) => result.isError === true)
    );
  }
  const item = block.item;
  return (
    (item.kind === "tool-call" && (item.isError === true || item.status === "failed")) ||
    (item.kind === "tool-result" && item.isError === true) ||
    (item.kind === "terminal-embed" && item.exitCode != null && item.exitCode !== 0)
  );
}

function blockOutcome(block: MessageBlock): keyof ProcessOutcomeCounts | undefined {
  if (blockHasIssue(block)) return "failed";
  if (block.kind === "tool") {
    return block.call.status === "completed" ? "succeeded" : undefined;
  }
  const item = block.item;
  if (item.kind === "tool-call") {
    return item.status === "completed" ? "succeeded" : undefined;
  }
  if (item.kind === "tool-result") {
    return item.isError ? "failed" : "succeeded";
  }
  if (item.kind === "terminal-embed" && item.exitCode != null) {
    return item.exitCode === 0 ? "succeeded" : "failed";
  }
  return undefined;
}

function countProcessOutcomes(blocks: MessageBlock[]): ProcessOutcomeCounts {
  const counts: ProcessOutcomeCounts = { succeeded: 0, failed: 0 };
  for (const block of blocks) {
    const outcome = blockOutcome(block);
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}

function formatOutcomeSummary(counts: ProcessOutcomeCounts, t: Translate): string {
  if (counts.failed <= 0) {
    return "";
  }

  const parts: string[] = [];
  if (counts.succeeded > 0) {
    parts.push(t("stream.activitySucceeded", { count: counts.succeeded }));
  }
  if (counts.failed > 0) {
    parts.push(t("stream.activityFailed", { count: counts.failed }));
  }
  return parts.join(" / ");
}

function blockIsRunning(block: MessageBlock): boolean {
  if (block.kind === "tool") {
    return block.call.status === "pending" || block.call.status === "running";
  }
  const item = block.item;
  return (
    (item.kind === "tool-call" &&
      (item.status === "pending" || item.status === "running")) ||
    (item.kind === "terminal-embed" && item.running === true)
  );
}

function buildDisplaySections(blocks: MessageBlock[]): MessageSection[] {
  const sections: MessageSection[] = [];
  let processRun: MessageBlock[] = [];
  const flushProcessRun = () => {
    if (processRun.length > 0) {
      sections.push({ kind: "process", blocks: processRun });
      processRun = [];
    }
  };

  for (const block of blocks) {
    if (isProcessBlock(block)) {
      processRun.push(block);
    } else {
      flushProcessRun();
      sections.push({ kind: "block", block });
    }
  }
  flushProcessRun();
  return sections;
}

function renderMessageBlock(block: MessageBlock, key: string | number) {
  return block.kind === "tool" ? (
    <StreamToolInvocation
      key={key}
      call={block.call}
      results={block.results}
      commands={block.commands}
      extras={block.extras}
    />
  ) : (
    <StreamItem key={key} item={block.item} />
  );
}

function StreamProcessGroup({ blocks }: { blocks: MessageBlock[] }) {
  const { t } = useTranslation();
  const hasRunning = blocks.some(blockIsRunning);
  const activityCounts = countProcessActivity(blocks);
  const outcomeCounts = countProcessOutcomes(blocks);
  const summary = formatActivitySummary(activityCounts, blocks.length, t);
  const outcomeSummary = formatOutcomeSummary(outcomeCounts, t);
  const outcomeNode = outcomeSummary ? (
    <span className="stream-process-outcome">{outcomeSummary}</span>
  ) : null;
  const Icon = dominantActivityIcon(activityCounts, hasRunning);
  const isSpinnerIcon = Icon === LoaderCircle;

  return (
    <details
      className={`stream-process${hasRunning ? " running" : ""}`}
      aria-label={t("stream.processDetails", { count: blocks.length })}
    >
      <summary>
        <Icon
          className={`stream-process-icon${isSpinnerIcon ? " spinning" : ""}`}
          aria-hidden="true"
        />
        <span className="stream-process-title">
          {hasRunning ? (
            <>
              <span className="stream-process-running-text">
                {t("stream.activityProcessing")}
              </span>
              <span className="stream-process-title-separator"> · </span>
              <span>{summary}</span>
              {outcomeNode}
            </>
          ) : (
            <>
              <span>{summary}</span>
              {outcomeNode}
            </>
          )}
        </span>
      </summary>
      <div className="stream-process-detail-list">
        {blocks.map((block, index) =>
          renderMessageBlock(block, `process-${index}`)
        )}
      </div>
    </details>
  );
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

function UserMessageText({ content }: { content: string }) {
  const segments = splitPluginMentions(content);
  return (
    <pre>
      {segments.map((segment, index) => {
        if (segment.kind === "plugin") {
          return (
            <span
              className="message-plugin-mention"
              title={segment.uri}
              aria-label={`Plugin ${pluginDisplayName(segment.name)}`}
              key={`${segment.uri}-${index}`}
            >
              <Package aria-hidden="true" />
              <span>{pluginDisplayName(segment.name)}</span>
            </span>
          );
        }
        return splitWorkspaceFileMentions(segment.value).map((fileSegment, fileIndex) =>
          fileSegment.kind === "mention" ? (
          <span
            className="workspace-file-mention"
            title={fileSegment.path}
            key={`${fileSegment.value}-${index}-${fileIndex}`}
          >
            {fileSegment.value}
          </span>
        ) : (
            splitAutolinkSegments(fileSegment.value).map((linkSegment, linkIndex) =>
              linkSegment.kind === "link" ? (
                <a
                  className="message-autolink"
                  href={linkSegment.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  key={`link-${index}-${fileIndex}-${linkIndex}`}
                >
                  {linkSegment.value}
                </a>
              ) : (
                <span key={`text-${index}-${fileIndex}-${linkIndex}`}>
                  {linkSegment.value}
                </span>
              )
            )
          )
        );
      })}
    </pre>
  );
}

export const MessageBubble = memo(function MessageBubble({
  message,
  adapter,
  agentName,
  agentIconKey,
  blockLimit,
  typingChars
}: {
  message: ConversationMessage;
  adapter?: string;
  agentName?: string;
  agentIconKey?: string;
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
  const renderedSections = useMemo(
    () => buildDisplaySections(renderedBlocks),
    [renderedBlocks]
  );
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
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<"up" | "down" | null>(null);
  const avatarRef = useRef<HTMLButtonElement | null>(null);
  const whipActive = useWhipEffectStore(
    (s) => s.active && s.targetMessageId === message.id
  );
  const whipPower = useWhipEffectStore((s) =>
    s.active && s.targetMessageId === message.id ? s.power : 1
  );
  const canWhip = message.role === "assistant";
  const [charging, setCharging] = useState(false);
  const chargeStartRef = useRef<number | null>(null);
  const comboRef = useRef<{ count: number; lastFire: number }>({ count: 0, lastFire: 0 });

  const computeWhipTarget = useCallback((): WhipTargetPoint => {
    const avatarEl = avatarRef.current;
    const chatView = avatarEl?.closest(".chat-view");
    if (!avatarEl || !chatView) return { x: 120, y: 120 };
    const ar = avatarEl.getBoundingClientRect();
    const cr = chatView.getBoundingClientRect();
    return {
      x: ar.left - cr.left + ar.width / 2,
      y: ar.top - cr.top + ar.height / 2
    };
  }, []);

  const powerFromChargeMs = useCallback((ms: number): number => {
    if (ms <= 120) return 0.9;
    if (ms >= 1300) return 1.9;
    return 0.9 + (ms - 120) / 1180;
  }, []);

  const fireWhip = useCallback(
    (chargePower: number) => {
      const state = useWhipEffectStore.getState();
      if (state.active) return;
      const now = performance.now();
      const combo = comboRef.current;
      const inWindow = now - combo.lastFire < 2500;
      combo.count = inWindow ? combo.count + 1 : 0;
      combo.lastFire = now;
      const power = Math.min(1.9, chargePower + combo.count * 0.2);
      state.trigger({
        messageId: message.id,
        target: computeWhipTarget(),
        power
      });
    },
    [computeWhipTarget, message.id]
  );

  const handleWhipStart = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!canWhip) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      chargeStartRef.current = performance.now();
      setCharging(true);
    },
    [canWhip]
  );

  const handleWhipRelease = useCallback(
    (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!canWhip || chargeStartRef.current == null) return;
      const dur = performance.now() - chargeStartRef.current;
      chargeStartRef.current = null;
      setCharging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      fireWhip(powerFromChargeMs(dur));
    },
    [canWhip, fireWhip, powerFromChargeMs]
  );

  const handleWhipCancel = useCallback(() => {
    chargeStartRef.current = null;
    setCharging(false);
  }, []);

  const handleWhipKeyActivate = useCallback(
    (e: MouseEvent) => {
      // Pointer-driven clicks (detail > 0) are handled by pointerup; this
      // branch only fires for keyboard activation (Enter / Space).
      if (e.detail > 0 || !canWhip) return;
      fireWhip(1);
    },
    [canWhip, fireWhip]
  );
  const copyText = messageText(message, items).trim();
  const showActionBar = message.role === "assistant" && message.status === "done" && Boolean(copyText);
  const doCopy = (text: string) => {
    if (text) void navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

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
          <Check className="msg-action-icon" aria-hidden="true" />
        ) : (
          <Copy className="msg-action-icon" aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={`msg-action-btn${vote === "up" ? " active up" : ""}`}
        onClick={() => setVote((v) => (v === "up" ? null : "up"))}
        title={t("message.upvote")}
        aria-label={t("message.upvote")}
      >
        <ThumbsUp className="msg-action-icon" aria-hidden="true" />
      </button>
      <button
        type="button"
        className={`msg-action-btn${vote === "down" ? " active down" : ""}`}
        onClick={() => setVote((v) => (v === "down" ? null : "down"))}
        title={t("message.downvote")}
        aria-label={t("message.downvote")}
      >
        <ThumbsDown className="msg-action-icon" aria-hidden="true" />
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
        <div className="msg-content-wrapper">
          <div className="msg-header">
            <span className="msg-author">{t("message.you")}</span>
          </div>
          {showBubble && (
            <div className="msg-bubble">
              {hasText && <UserMessageText content={message.content} />}
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
  const agentLabel = displayAgentName(message.agentName ?? agentName, adapter);
  const statusText =
    message.status !== "ready" ? t(`status.${message.status}`) : null;

  return (
    <div className="msg msg-assistant">
      <button
        type="button"
        ref={avatarRef}
        className={`msg-avatar-whip-target${canWhip ? " whipable" : ""}${whipActive ? " whip-hit" : ""}${charging ? " charging" : ""}`}
        onClick={canWhip ? handleWhipKeyActivate : undefined}
        onPointerDown={canWhip ? handleWhipStart : undefined}
        onPointerUp={canWhip ? handleWhipRelease : undefined}
        onPointerCancel={canWhip ? handleWhipCancel : undefined}
        disabled={!canWhip}
        aria-label={canWhip ? t("message.whipAvatar") : undefined}
        tabIndex={canWhip ? 0 : -1}
        style={{ "--whip-power": whipPower } as CSSProperties}
      >
        <AgentAvatar
          adapter={message.adapter ?? adapter}
          agentId={message.agentId}
          iconKey={agentIconKey}
          className="msg-avatar agent-avatar"
          fallback={<span>✦</span>}
        />
      </button>
      <div className="msg-content-wrapper">
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
              {renderedSections.map((section, i) =>
                section.kind === "process" ? (
                  <StreamProcessGroup
                    key={`process-${i}`}
                    blocks={section.blocks}
                  />
                ) : (
                  renderMessageBlock(section.block, `block-${i}`)
                )
              )}
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
      </div>
    </div>
  );
});
