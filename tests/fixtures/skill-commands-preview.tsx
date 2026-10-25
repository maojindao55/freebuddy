// Production composer and send path, with memory-only data and no agent process.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import { ChatView } from "../../src/components/CLI/ChatView";
import { ConversationList } from "../../src/components/CLI/ConversationList";
import { ErrorBoundary } from "../../src/components/ErrorBoundary";
import { builtinCliMembers } from "../../src/config/aiMembers";
import { useConversationStore } from "../../src/store/conversationStore";
import { useCliExecutorStore } from "../../src/store/cliExecutorStore";
import { useWorkflowStore } from "../../src/store/workflowStore";
import { useWorkflowTeamStore } from "../../src/store/workflowTeamStore";
import { useDelegationTeamStore } from "../../src/store/delegationStore";
import { useSkillStore } from "../../src/store/skillStore";
import { useMcpServerStore } from "../../src/store/mcpServerStore";
import { useNewTaskUiStore } from "../../src/store/newTaskUiStore";
import { useProjectStore } from "../../src/store/projectStore";
import type { Conversation, ConversationMessage, ConversationContextReference, CreateConversationShareResult, CliRunArgs } from "../../src/services/cli/types";
import type { SkillRecord } from "../../src/services/skills/types";

void i18next.changeLanguage("zh-CN");
document.documentElement.dataset.theme = "light";
const now = new Date().toISOString();
const member = builtinCliMembers.find(entry => entry.id === "cli-codex-acp")!;
const noop = async () => {};
const conversation: Conversation = { id: "skill-preview", title: "优化登录页面的交互", agentId: member.id, agentName: member.name, adapter: member.cli.adapter, cwd: "/Users/demo/www/freebuddy", skillSnapshot: [], archived: false, createdAt: now, updatedAt: now };
const sourceConversations: Conversation[] = [
  { ...conversation, id: "login-research", title: "登录流程：需求与边界情况", agentId: "cli-claude", adapter: "claude", agentName: "Claude", updatedAt: "2026-10-24T09:00:00Z" },
  { ...conversation, id: "design-system", title: "界面设计规范与组件约定", agentName: "Codex", updatedAt: "2026-10-23T09:00:00Z" },
  { ...conversation, id: "api-design", title: "认证接口与错误处理", agentId: "cli-gemini", adapter: "gemini", agentName: "Gemini", updatedAt: "2026-10-22T09:00:00Z" }
];
const shares = new Map<string, CreateConversationShareResult>();
const references = new Map<string, ConversationContextReference[]>();
let shareIndex = 0;
const records: SkillRecord[] = [
  ["code-review", "代码审查", "检查代码改动，发现潜在缺陷、边界情况与遗漏的测试。"],
  ["frontend-design", "前端设计", "设计并实现清晰、易用的界面，沿用项目现有的视觉规范。"],
  ["debugging", "问题排查", "分析错误日志和复现步骤，定位根因并验证修复。"],
  ["writing", "文档写作", "整理需求、撰写说明文档，让复杂内容更容易理解。"],
  ["untrusted", "未信任技能", "不应出现在选择列表中"]
].map(([id, name, description]) => ({ id, name, description, version: "1.0.0", source: "imported", rootPath: `/fixture/skills/${id}`, contentHash: id, enabled: true, trusted: id !== "untrusted", createdAt: now, updatedAt: now }));
const saved = new Map<string, ConversationMessage>();
let onRun: (args: CliRunArgs) => void = () => {};
const methods = {
  getSetting: async () => null, setSetting: noop,
  listConversationContextReferences: async (id: string) => references.get(id) ?? [], listFollowupMessages: async () => [],
  listConversations: async () => useConversationStore.getState().conversations,
  listMessages: async (id: string) => ({ messages: useConversationStore.getState().messages[id] ?? [], hasMore: false }),
  getCachedSessionConfigOptions: async () => [], inspectSessionConfigOptions: async () => [],
  inspectTaskWorkspace: async () => ({ isGitRepository: true, currentBranch: "main", branches: ["main"] }),
  prepareTaskWorkspace: async ({ cwd }: { cwd: string }) => ({ cwd, sourceCwd: cwd, mode: "local" }),
  searchWorkspaceFiles: async () => [],
  createConversationShare: async ({ sourceConversationId }: { sourceConversationId: string }) => {
    const source = useConversationStore.getState().conversations.find(entry => entry.id === sourceConversationId)!;
    const snapshotId = `snapshot-${++shareIndex}`;
    const link = `freebuddy://conversation-share/v1/previewConversationShareToken${shareIndex}`;
    const result: CreateConversationShareResult = { link, snapshotId, source: { conversationId: source.id, title: source.title, agentId: source.agentId, agentName: source.agentName, adapter: source.adapter, cwd: source.cwd, messageCount: 12 }, transcriptAvailable: true, transcriptTruncated: false };
    shares.set(link, result);
    return result;
  },
  attachConversationShares: async ({ targetConversationId, text }: { targetConversationId: string; text: string }) => {
    const existing = references.get(targetConversationId) ?? [];
    const next = [...existing];
    for (const [link, share] of shares) {
      if (text.includes(link) && !next.some(entry => entry.snapshotId === share.snapshotId)) next.push({ id: `ref-${share.snapshotId}`, snapshotId: share.snapshotId, targetConversationId, referenceType: "share", source: share.source, transcriptAvailable: true, transcriptTruncated: false, createdAt: new Date().toISOString() });
    }
    references.set(targetConversationId, next);
    return { references: next, attachedCount: next.length - existing.length };
  },
  check: async () => ({ installed: true }),
  getToolSession: async () => ({ adapter: member.cli.adapter, sessionId: "fixture-session" }),
  awaitPendingMcpSelection: noop,
  appendMessage: async (input: ConversationMessage) => {
    const message = { ...input, createdAt: now, updatedAt: now };
    saved.set(message.id, message);
    return message;
  },
  updateMessage: noop, onEvent: () => () => {},
  createConversation: async (input: Partial<Conversation>) => ({ ...conversation, ...input, id: `new-${Date.now()}`, skillSnapshot: [] }),
  run: async (args: CliRunArgs) => {
    onRun(args);
    useConversationStore.setState(state => ({
      live: {},
      messages: { ...state.messages, [args.conversationId!]: (state.messages[args.conversationId!] ?? []).map(message => message.role === "assistant" && message.status === "running"
        ? { ...message, status: "done", content: JSON.stringify([{ kind: "text", content: "已收到任务。这是本地交互预览，没有启动真实 Agent。" }]) } : message) }
    }));
  }
};
window.freebuddy = {
  platform: "darwin", cli: new Proxy(methods, { get: (target, prop) => target[prop] ?? noop }),
  settings: { getSetting: async () => null, setSetting: noop },
  plugins: { list: async () => ({ plugins: [], marketplaces: [] }) }, debugLogs: { write: noop }
} as never;
useConversationStore.setState({ activeId: conversation.id, members: [member], conversations: [conversation, ...sourceConversations], messages: {}, refreshMembers: noop });
useCliExecutorStore.setState({ loaded: true, refreshRuntimes: noop, runtimes: { "codex-acp": { adapter: "codex-acp", installed: true, lastCheckAt: now } } });
useSkillStore.setState({ loaded: true, loading: false, skills: records });
useMcpServerStore.setState({ loaded: true, servers: [] });
useWorkflowStore.setState({ loadForConversation: noop, loadActiveRuns: noop });
useWorkflowTeamStore.setState({ loaded: true, teams: [] });
useDelegationTeamStore.setState({ loaded: true, teams: [] });
useProjectStore.setState({ loaded: true, projects: [], refresh: noop, ensureForCwd: async () => ({ id: "fixture-project" }) as never });

function Preview() {
  const [lastRun, setLastRun] = useState<CliRunArgs>();
  const [theme, setTheme] = useState("light");
  onRun = setLastRun;
  return <div className="skill-reference-preview" style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--fb-home-bg-primary)" }}>
    <style>{".skill-reference-preview { --fb-detail-width: 0px; }"}</style>
    <nav style={{ display: "flex", flexWrap: "wrap", gap: 12, padding: "12px 24px", borderBottom: "1px solid var(--fb-border)", fontSize: 12 }}>
      <button onClick={() => useConversationStore.setState({ activeId: conversation.id })}>已有会话</button>
      <button onClick={() => { useConversationStore.setState({ activeId: undefined }); useNewTaskUiStore.getState().requestNewTask({ cwd: conversation.cwd }); }}>新任务</button>
      <button onClick={() => { const next = theme === "light" ? "dark" : "light"; setTheme(next); document.documentElement.dataset.theme = next; }}>切换主题</button>
      <button onClick={() => void i18next.changeLanguage(i18next.language === "zh-CN" ? "en" : "zh-CN")}>中 / EN</button>
      <button onClick={() => useSkillStore.setState({ skills: [] })}>空技能列表</button>
      <button onClick={() => useSkillStore.setState({ skills: records })}>恢复技能</button>
      <span aria-label="上次调用技能">上次调用：{lastRun?.skills?.map(skill => skill.name).join("、") || "无"}</span>
    </nav>
    <main style={{ minHeight: 0, flex: 1, display: "flex" }}>
      <aside aria-label="会话列表" style={{ width: 272, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--fb-border)", background: "var(--fb-sidebar-bg)" }}><ConversationList /></aside>
      <div style={{ position: "relative", flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column" }}><ChatView /></div>
    </main>
  </div>;
}
// The layout fixture reuses this memory-only setup without mounting a second root.
const previewHost = document.getElementById("root")!;
if (previewHost.dataset.fixture !== "browser-layout") {
  const previewRoot = createRoot(previewHost);
  previewRoot.render(<StrictMode><ErrorBoundary><Preview /></ErrorBoundary></StrictMode>);
  import.meta.hot?.dispose(() => previewRoot.unmount());
}
