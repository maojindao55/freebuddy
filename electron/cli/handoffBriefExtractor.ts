import type { Conversation, ConversationMessage } from "./conversations.js";
import type {
  HandoffBrief,
  HandoffBriefFileChange,
  HandoffBriefMessageRef,
  ParsedAssistantStreamItem
} from "../shared/handoffTypes.js";

const MAX_ORIGINAL_GOAL = 2000;
const MAX_RECENT_USER = 800;
const MAX_ASSISTANT_SUMMARY = 2000;
const MAX_EXCERPT = 800;
const MAX_TRANSCRIPT_REFS = 8;
const MAX_FILE_CHANGES = 50;
const SIZE_LIMIT = 64 * 1024;

const FILE_TOOL_NAMES = new Set([
  "apply_patch", "write", "edit", "update", "str_replace",
  "create_file", "edit_file", "multi_edit", "read_file"
]);

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max);
}

function parseAssistantItems(msg: ConversationMessage): ParsedAssistantStreamItem[] | null {
  try {
    const parsed = JSON.parse(msg.content);
    if (!Array.isArray(parsed)) return null;
    return parsed as ParsedAssistantStreamItem[];
  } catch {
    return null;
  }
}

function extractAssistantText(items: ParsedAssistantStreamItem[]): string {
  return items
    .filter((it) => it.kind === "text" && typeof it.content === "string")
    .map((it) => it.content ?? "")
    .join("");
}

function actionFromToolKind(toolKind: string | undefined): "edit" | "delete" | "read" {
  if (toolKind === "delete") return "delete";
  if (toolKind === "read") return "read";
  return "edit";
}

// file-edit items emit action in {"create","update","delete"}; normalize to the
// canonical HandoffBriefFileChange action set {"edit","create","delete","read"}.
function normalizeFileEditAction(action: string | undefined): "edit" | "create" | "delete" {
  if (action === "create") return "create";
  if (action === "delete") return "delete";
  return "edit";
}

function collectFileChanges(messages: ConversationMessage[]): HandoffBriefFileChange[] {
  const byPath = new Map<string, HandoffBriefFileChange>();
  const order: string[] = [];
  const seenPaths = new Set<string>();

  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const items = parseAssistantItems(msg);
    if (!items) continue;

    for (const item of items) {
      if (item.kind === "file-edit") {
        const p = typeof item.path === "string" ? item.path : "";
        if (!p) continue;
        const next: HandoffBriefFileChange = { path: p, action: normalizeFileEditAction(item.action) };
        const prev = byPath.get(p);
        if (!(prev && prev.action !== "read" && next.action === "read")) {
          byPath.set(p, next);
          if (!seenPaths.has(p)) {
            seenPaths.add(p);
            order.push(p);
          }
        }
      } else if (item.kind === "tool-call") {
        const toolKind = item.toolKind;
        const toolName = item.tool;
        const isMatch =
          toolKind === "edit" || toolKind === "delete" || toolKind === "read" ||
          (typeof toolName === "string" && FILE_TOOL_NAMES.has(toolName));
        if (!isMatch) continue;
        const locations = Array.isArray(item.locations) ? item.locations : [];
        for (const loc of locations) {
          const p = typeof loc?.path === "string" ? loc.path : "";
          if (!p) continue;
          const next: HandoffBriefFileChange = {
            path: p,
            action: actionFromToolKind(toolKind),
            toolName: toolName
          };
          const prev = byPath.get(p);
          if (!(prev && prev.action !== "read" && next.action === "read")) {
            byPath.set(p, next);
            if (!seenPaths.has(p)) {
              seenPaths.add(p);
              order.push(p);
            }
          }
        }
      }
    }
  }

  // 排序：出现顺序倒序（最近改动排前）
  const ordered = order.slice().reverse().map((p) => byPath.get(p)!);

  // 上限 50：非 read 优先 + 最近优先
  if (ordered.length <= MAX_FILE_CHANGES) return ordered;
  const nonRead = ordered.filter((c) => c.action !== "read");
  const reads = ordered.filter((c) => c.action === "read");
  const picks = [...nonRead, ...reads].slice(0, MAX_FILE_CHANGES);
  return picks;
}

function excerptForMessage(msg: ConversationMessage): string {
  if (msg.role === "user") return clip(msg.content, MAX_EXCERPT);
  if (msg.status !== "done" && msg.status !== "sent") return "(streaming)";
  const items = parseAssistantItems(msg);
  if (!items) return "(malformed)";
  const text = extractAssistantText(items);
  return text.trim() ? clip(text, MAX_EXCERPT) : "(tool calls only)";
}

function trimForSize(brief: HandoffBrief): HandoffBrief {
  let b = brief;

  const stages: Array<() => void> = [
    () => { b = { ...b, transcriptExcerpts: b.transcriptExcerpts.slice(0, 4) }; },
    () => { b = { ...b, transcriptExcerpts: b.transcriptExcerpts.slice(0, 2) }; },
    () => { b = { ...b, transcriptExcerpts: [] }; },
    () => {
      const nonRead = b.fileChanges.filter((c) => c.action !== "read");
      b = { ...b, fileChanges: [...nonRead, ...b.fileChanges.filter((c) => c.action === "read")].slice(0, 25) };
    },
    () => { b = { ...b, fileChanges: b.fileChanges.filter((c) => c.action !== "read").slice(0, 10) }; },
    () => { b = { ...b, recentUserMessages: b.recentUserMessages.slice(0, 2) }; },
    () => { b = { ...b, recentUserMessages: b.recentUserMessages.slice(0, 1) }; },
    () => { b = { ...b, lastAssistantSummary: b.lastAssistantSummary.slice(0, 1000) }; },
    () => { b = { ...b, lastAssistantSummary: b.lastAssistantSummary.slice(0, 500) }; },
    () => { b = { ...b, lastAssistantSummary: b.lastAssistantSummary.slice(0, 200) }; },
    () => { b = { ...b, originalGoal: b.originalGoal.slice(0, 500) }; }
  ];

  let i = 0;
  while (JSON.stringify(b).length > SIZE_LIMIT && i < stages.length) {
    stages[i]();
    i++;
  }
  return b;
}

export interface ExtractInput {
  conversation: Conversation;
  messages: ConversationMessage[];
}

export function extractHandoffBrief(input: ExtractInput): HandoffBrief {
  const { conversation: c, messages } = input;

  const userMsgs = messages.filter((m) => m.role === "user");
  const originalGoal = userMsgs.length > 0 ? clip(userMsgs[0].content, MAX_ORIGINAL_GOAL) : "";

  const recentUser = userMsgs.length > 1
    ? userMsgs.slice(Math.max(1, userMsgs.length - 3)).map((m) => clip(m.content, MAX_RECENT_USER))
    : [];

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  let lastAssistantSummary = "";
  if (lastAssistant && (lastAssistant.status === "done" || lastAssistant.status === "sent")) {
    const items = parseAssistantItems(lastAssistant);
    if (items) lastAssistantSummary = clip(extractAssistantText(items), MAX_ASSISTANT_SUMMARY);
  }

  const fileChanges = collectFileChanges(messages);

  const tail = messages.slice(-MAX_TRANSCRIPT_REFS);
  const transcriptExcerpts: HandoffBriefMessageRef[] = tail
    .filter((m) => m.role !== "system")
    .map((m) => ({
      messageId: m.id,
      role: m.role as "user" | "assistant",
      createdAt: m.createdAt,
      excerpt: excerptForMessage(m)
    }));

  const brief: HandoffBrief = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: {
      conversationId: c.id,
      agentId: c.agentId,
      agentName: c.agentName,
      adapter: c.adapter,
      title: c.title,
      cwd: c.cwd,
      messageCount: messages.length
    },
    originalGoal,
    recentUserMessages: recentUser,
    lastAssistantSummary,
    fileChanges,
    transcriptExcerpts
  };

  return trimForSize(brief);
}
