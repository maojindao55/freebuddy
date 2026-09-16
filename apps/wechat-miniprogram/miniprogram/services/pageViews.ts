/**
 * Read-only page view models.
 *
 * Pages are intentionally dumb: they render the object these builders return and forward taps to
 * a controller. Everything that decides "what does this state mean to the operator" — tone,
 * labels, empty/loading/offline/terminal messaging, whether an action is even offered — lives
 * here, where it is a pure function of the store state and can be unit-tested without WeChat.
 *
 * Two properties are structural rather than stylistic:
 *
 * 1. **Message content is plain text.** `renderMessageText` normalises line endings, removes C0
 *    control characters and bounds the length. It never produces HTML, Markdown or a link, and the
 *    WXML only ever binds it through `<text>` interpolation. There is therefore no HTML/JS
 *    execution surface and no scheme (web-view, http link, file path) that a host could smuggle
 *    into a page.
 * 2. **No write surface exists.** `ChatView.canSend` is the literal `false` and the chat view has
 *    no decision/terminal fields, so a page cannot render an action the protocol cannot serve in
 *    this stage.
 */

import type { ConversationListState } from "../stores/conversationStore";
import type { ConnectionState } from "../stores/connectionStore";
import type { HostState } from "../stores/hostStore";
import type { MessageThreadState } from "../stores/messageStore";
import type { ConversationSummary, MessageSummary, RemoteId } from "../protocol/remote.generated";
import type { ConnectionStatus } from "../services/relaySocket";
import { formatClock, previewText, shortId, type Tone } from "../utils/view";

/** Routes are constants so a page cannot navigate to an arbitrary path. */
export const ROUTES = {
  login: "/pages/index/index",
  home: "/pages/home/home",
  conversations: "/pages/conversations/conversations",
  chat: "/pages/chat/chat"
} as const;

export type RouteName = keyof typeof ROUTES;

export const MAX_ROUTE_ID_CHARS = 128;

export function routeTo(name: RouteName): string {
  return ROUTES[name];
}

export function chatRoute(conversationId: RemoteId): string {
  return `${ROUTES.chat}?conversationId=${encodeURIComponent(conversationId)}`;
}

/**
 * Reads the conversation id out of a page query. Bounded and type-checked, so a hand-typed or
 * truncated query cannot become an RPC parameter the protocol would reject anyway.
 */
export function readConversationId(query: Record<string, unknown> | undefined): RemoteId | null {
  const raw = query?.conversationId;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  // WeChat decodes query values, but a router that did not would leave `%xx` escapes behind; undo
  // them defensively and fall back to the raw value if it is not valid percent-encoding.
  let value = raw;
  if (/%[0-9A-Fa-f]{2}/.test(raw)) {
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
  }
  if (value.length === 0 || value.length > MAX_ROUTE_ID_CHARS) {
    return null;
  }
  return value;
}

/** True when the transport can actually carry a read right now. */
export function canReadConnection(status: ConnectionStatus): boolean {
  return status === "online";
}

export interface ConnectionBanner {
  readonly status: ConnectionStatus;
  readonly tone: Tone;
  readonly label: string;
  readonly detail: string;
  /** Offers an explicit retry: only meaningful for transient states. */
  readonly canReconnect: boolean;
  /** The operator must supply/refresh a credential before anything else can work. */
  readonly needsCredential: boolean;
  /** Terminal states stop automatic retrying, so the UI must say so. */
  readonly terminal: boolean;
}

export function buildConnectionBanner(state: ConnectionState): ConnectionBanner {
  const base = { status: state.status, detail: state.reasonMessage } as const;
  switch (state.status) {
    case "online":
      return {
        ...base,
        tone: "ok",
        label: "已连接",
        detail: state.resyncRequired ? "连接正常，正在重新获取快照" : "实时连接正常",
        canReconnect: false,
        needsCredential: false,
        terminal: false
      };
    case "connecting":
      return { ...base, tone: "neutral", label: "连接中", detail: "正在建立连接", canReconnect: false, needsCredential: false, terminal: false };
    case "authenticating":
      return { ...base, tone: "neutral", label: "认证中", detail: "等待 Relay 校验凭证", canReconnect: false, needsCredential: false, terminal: false };
    case "backoff":
      return {
        ...base,
        tone: "warn",
        label: "重连中",
        detail:
          state.nextRetryInMs === null
            ? state.reasonMessage
            : `${state.reasonMessage}（约 ${Math.max(1, Math.ceil(state.nextRetryInMs / 1000))} 秒后重试）`,
        canReconnect: true,
        needsCredential: false,
        terminal: false
      };
    case "offline":
      return { ...base, tone: "error", label: "已离线", canReconnect: true, needsCredential: false, terminal: false };
    case "signedOut":
      return { ...base, tone: "neutral", label: "未连接", canReconnect: false, needsCredential: true, terminal: true };
    case "forbidden":
      return { ...base, tone: "error", label: "凭证被拒绝", canReconnect: false, needsCredential: true, terminal: true };
    case "incompatible":
      return { ...base, tone: "error", label: "协议版本不兼容", canReconnect: false, needsCredential: false, terminal: true };
    default:
      return { ...base, tone: "neutral", label: "状态未知", canReconnect: false, needsCredential: false, terminal: false };
  }
}

export interface HomeMetricView {
  readonly label: string;
  readonly value: string;
}

export interface HomeRowView {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
}

export interface HomeView {
  readonly banner: ConnectionBanner;
  readonly environment: string;
  readonly hasHost: boolean;
  readonly hostTitle: string;
  readonly hostSubtitle: string;
  readonly hostTone: Tone;
  readonly remoteEnabled: boolean;
  readonly metrics: readonly HomeMetricView[];
  readonly projects: readonly HomeRowView[];
  readonly pendingDecisions: readonly HomeRowView[];
  readonly activeTasks: readonly HomeRowView[];
  readonly hasPendingDecisions: boolean;
  readonly credentialNotice: string;
  readonly isDevConnection: boolean;
}

export interface HomeViewInput {
  readonly connection: ConnectionState;
  readonly host: HostState;
  readonly environmentName: string;
  /** Where the current credential came from; DEV is never presented as a WeChat login. */
  readonly credentialSource: "wechat_code" | "dev_operator_token" | "none";
}

export const READ_ONLY_NOTICE =
  "只读视图：本阶段不提供发送消息、停止运行、响应决策或终端操作。";

export function buildHomeView(input: HomeViewInput): HomeView {
  const { connection, host } = input;
  const status = host.host;
  const hasHost = status !== null;

  const metrics: HomeMetricView[] = hasHost
    ? [
        { label: "运行中", value: String(status.activeRunCount) },
        { label: "待决策", value: String(status.pendingDecisionCount) },
        { label: "终端", value: String(status.activeTerminalCount) },
        { label: "项目", value: String(host.projects.length) },
        { label: "Agent", value: String(host.agents.length) }
      ]
    : [];

  const projects: HomeRowView[] = host.projects.map((project) => ({
    id: project.projectId,
    title: previewText(project.name, 80),
    subtitle: shortId(project.projectId)
  }));

  const pendingDecisions: HomeRowView[] = host.pendingDecisions.map((decision) => ({
    id: decision.decisionId,
    title: previewText(decision.summary, 120),
    subtitle: `${decision.kind === "permission" ? "权限" : "认证"} · ${shortId(decision.runId)}`
  }));

  const activeTasks: HomeRowView[] = host.activeTasks.map((task) => ({
    id: task.taskId,
    title: previewText(task.title, 80),
    subtitle: `${task.status} · ${formatClock(task.updatedAt)}`
  }));

  const isDevConnection = input.credentialSource === "dev_operator_token";

  return {
    banner: buildConnectionBanner(connection),
    environment: input.environmentName,
    hasHost,
    hostTitle: hasHost ? previewText(status.displayName ?? status.hostId, 80) : "尚未获取主机状态",
    hostSubtitle: hasHost
      ? `${status.online ? "在线" : "离线"} · 应用 ${status.appVersion} · 协议 v${status.protocolVersion}`
      : "连接成功后由主机快照填充",
    hostTone: hasHost ? (status.online ? "ok" : "warn") : "neutral",
    remoteEnabled: hasHost && status.remoteEnabled,
    metrics,
    projects,
    pendingDecisions,
    activeTasks,
    hasPendingDecisions: pendingDecisions.length > 0,
    credentialNotice: isDevConnection
      ? `环境 ${input.environmentName}：本地 DEV 直连，非微信管理员登录。${READ_ONLY_NOTICE}`
      : `${READ_ONLY_NOTICE}`,
    isDevConnection
  };
}

export interface ConversationRowView {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  readonly archived: boolean;
}

export interface ConversationListView {
  readonly banner: ConnectionBanner;
  readonly items: readonly ConversationRowView[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly hasMore: boolean;
  readonly cursor: string | null;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly emptyMessage: string;
  readonly loadMoreEnabled: boolean;
  readonly refreshEnabled: boolean;
}

export const EMPTY_CONVERSATIONS_OFFLINE = "主机离线时无法加载会话。连接恢复后会自动获取。";
export const EMPTY_CONVERSATIONS_NONE = "该主机还没有会话。";

export function buildConversationListView(
  list: ConversationListState,
  connection: ConnectionState
): ConversationListView {
  const banner = buildConnectionBanner(connection);
  const readable = canReadConnection(connection.status);

  const items: ConversationRowView[] = list.items.map((conversation: ConversationSummary) => ({
    id: conversation.conversationId,
    title: previewText(conversation.title, 80),
    subtitle: `${formatClock(conversation.lastMessageAt ?? conversation.updatedAt)} · ${shortId(conversation.conversationId)}`,
    archived: conversation.archived
  }));

  return {
    banner,
    items,
    loading: list.loading,
    refreshing: list.refreshing,
    hasMore: list.hasMore,
    cursor: list.cursor,
    truncated: list.truncated,
    error: list.error,
    empty: list.loaded && items.length === 0 && !list.loading && list.error === null,
    emptyMessage: readable ? EMPTY_CONVERSATIONS_NONE : EMPTY_CONVERSATIONS_OFFLINE,
    loadMoreEnabled: readable && list.hasMore && !list.loading,
    refreshEnabled: readable && !list.loading
  };
}

export interface ChatMessageView {
  readonly id: string;
  readonly role: MessageSummary["role"];
  readonly roleLabel: string;
  readonly text: string;
  readonly truncated: boolean;
  readonly at: string;
}

export interface ChatView {
  readonly banner: ConnectionBanner;
  readonly conversationId: string;
  readonly title: string;
  readonly subtitle: string;
  readonly messages: readonly ChatMessageView[];
  readonly loading: boolean;
  readonly hasMore: boolean;
  readonly loadedOlder: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
  readonly empty: boolean;
  readonly emptyMessage: string;
  readonly loadOlderEnabled: boolean;
  readonly readonlyNotice: string;
  /** Literal `false`: this stage has no send path, and the view says so at the type level. */
  readonly canSend: false;
}

export const EMPTY_MESSAGES_OFFLINE = "主机离线时无法加载消息。";
export const EMPTY_MESSAGES_NONE = "该会话还没有消息。";

/** Bounded so a single huge message cannot make the page unresponsive. */
export const MAX_MESSAGE_RENDER_CHARS = 4_000;

/**
 * Plain-text rendering.
 *
 * Keeps tabs/newlines (readability), drops every other C0/C1 control character, normalises CRLF
 * and bounds the result. Deliberately does not interpret Markdown, HTML, or any scheme: the output
 * is text, and the WXML binds it as text.
 */
export function renderMessageText(content: unknown, max: number = MAX_MESSAGE_RENDER_CHARS): string {
  const text = String(content ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function roleLabelOf(role: MessageSummary["role"]): string {
  switch (role) {
    case "user":
      return "我";
    case "assistant":
      return "助手";
    case "system":
      return "系统";
    default:
      return "未知";
  }
}

export function buildChatView(
  conversationId: RemoteId,
  conversationTitle: string | null,
  thread: MessageThreadState,
  connection: ConnectionState
): ChatView {
  const banner = buildConnectionBanner(connection);
  const readable = canReadConnection(connection.status);

  const messages: ChatMessageView[] = thread.items.map((message) => ({
    id: message.messageId,
    role: message.role,
    roleLabel: roleLabelOf(message.role),
    // Never the raw value: control characters are removed and the length is bounded.
    text: renderMessageText(message.content),
    truncated: message.truncated === true,
    at: formatClock(message.createdAt)
  }));

  return {
    banner,
    conversationId,
    title: conversationTitle === null ? shortId(conversationId) : previewText(conversationTitle, 80),
    subtitle: shortId(conversationId),
    messages,
    loading: thread.loading,
    hasMore: thread.hasMore,
    loadedOlder: thread.loadedOlder,
    truncated: thread.truncated,
    error: thread.error,
    empty: thread.loaded && messages.length === 0 && !thread.loading && thread.error === null,
    emptyMessage: readable ? EMPTY_MESSAGES_NONE : EMPTY_MESSAGES_OFFLINE,
    loadOlderEnabled: readable && thread.hasMore && !thread.loading,
    readonlyNotice: READ_ONLY_NOTICE,
    canSend: false
  };
}
