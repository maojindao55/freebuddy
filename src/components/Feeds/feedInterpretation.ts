import { type TFunction } from "i18next";

import type { FeedItem } from "@/services/feed/types";
import type { ConversationMessage } from "@/services/cli/types";

export function clipFeedTitle(value: string, max = 80): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}...`;
}

export function buildFeedInterpretPrompt(item: FeedItem, t: TFunction): string {
  const lines = [
    t("feed.interpretPromptIntro"),
    "",
    t("feed.interpretPromptTitle", { title: item.title }),
    t("feed.interpretPromptSource", { source: item.sourceTitle }),
    t("feed.interpretPromptLink", { link: item.link })
  ];
  if (item.summary?.trim()) {
    lines.push("", t("feed.interpretPromptSummary"), item.summary.trim());
  }
  lines.push("", t("feed.interpretPromptOutput"));
  return lines.join("\n");
}

function isFeedInterpretPrompt(content: string): boolean {
  const hasTitle =
    content.includes("\u6587\u7ae0\u6807\u9898\uff1a") ||
    content.includes("Article title:");
  const hasLink =
    content.includes("\u94fe\u63a5\uff1a") || content.includes("Link:");
  const hasOutput =
    content.includes("\u8bf7\u8f93\u51fa\uff1a") ||
    content.includes("Please output:");
  return hasTitle && hasLink && hasOutput;
}

export function isFeedInterpretConversation(
  messages: ConversationMessage[]
): boolean {
  return messages.some(
    (message) => message.role === "user" && isFeedInterpretPrompt(message.content)
  );
}
