// Isolated visual QA fixture. Production App/components are imported unchanged;
// all data and bridge writes below are in-memory and never launch agents.
import { cliAdapterDefinitions } from "/src/config/cliAdapters.ts";

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const basicDefinitions = [
  ["release", "修复发布页缓存", "codex-acp", "Codex", "freebuddy", "running", "gpt-5", 0],
  ["signing", "排查 Windows 签名失败", "claude-agent-acp", "Claude Code", "freebuddy", "needs-input", "sonnet", 3],
  ["readme", "同步 README 中英文", "kimi-acp", "Kimi CLI", "freebuddy", "completed", "k2", 12],
  ["mobile", "修复移动端横向溢出", "codex-acp", "Codex", "site", "running", "gpt-5", 6],
  ["docs", "整理接口文档", "claude-agent-acp", "Claude Code", "api", "completed", "sonnet", 28],
  ["login", "对比登录方案", "kimi-acp", "Kimi CLI", "workspace", "idle", "k2", 60]
] as const;

// Reproduce real-world card density without accessing the user's database.
const contentStress = new URLSearchParams(location.search).get("scenario") === "content-stress";
const stressBase = [
  ["hello-deepseek", "你好", "dsh-acp", "DeepSeek Harness", "", "completed", "senseaudio-preview", 4320],
  ["markdown-reply", "生成1300行任意主题Markdown文件", "devin-acp", "Devin", "work", "completed", "SWE-2", 4320],
  ["markdown-tools", "生成1300行任意内容的Markdown文件", "devin-acp", "Devin", "", "completed", "SWE-2", 5760],
  ["hello-antigravity", "你好", "agy-acp", "Antigravity", "", "completed", "Gemini 3.8", 11520],
  ["diagram", "用户消息: 复述下 附件: - 7a3df4c6dd42df52b3018744c5b77ba.png", "qoder-acp", "Qoder", "", "completed", "Extra High", 11520],
  ["team-tools", "让你的同事,给我打个招数", "pi-acp", "Pi", "", "completed", "freebuddy-preview", 14400]
] as const;
const stressDefinitions = [
  ...stressBase,
  ...Array.from({ length: 36 }, (_, index) => [
    `history-${index}`, index < 13 ? `检查项目配置 ${index + 1}` : `历史讨论 ${index + 1}`,
    "codex-acp", "Codex", index % 2 ? "work" : "api", index < 13 ? "needs-input" : "completed", "gpt-5", 16000 + index
  ] as const)
];
const definitions = contentStress ? stressDefinitions : basicDefinitions;

let conversations = definitions.map(([id, title, adapter, agentName, project, , , minutes], index) => ({
  id, title, titleSource: "user", agentId: `cli-${adapter}`, adapter, agentName,
  cwd: `/preview/${project}`, projectId: project, kind: "default", skillSnapshot: [],
  archived: false, createdAt: ago(120), updatedAt: ago(minutes), lastMessageAt: ago(index)
}));
const projects = ["freebuddy", "site", "api", "workspace"].map((id) => ({ id, name: id, folders: [`/preview/${id}`], primaryPath: `/preview/${id}`, createdAt: ago(120), updatedAt: ago(120) }));
const activity = (conversationId: string, index: number, target: string, toolKind = "other", status = "completed", filePath?: string) => ({
  id: `${conversationId}-${index}`, messageId: `${conversationId}-reply`, toolCallId: `${conversationId}-${index}`,
  kind: "tool-call", toolKind, status, target, filePath
});
const activities = {
  release: [activity("release", 1, "site/main.js", "read", "completed", "site/main.js"), activity("release", 2, "loadRelease() +48 行", "edit"), activity("release", 3, "检查 API 限流降级"), activity("release", 4, "验证缓存回退机制…", "other", "running")],
  signing: [activity("signing", 1, "分析打包日志"), activity("signing", 2, "electron-builder.yml", "edit", "completed", "electron-builder.yml"), activity("signing", 3, "定位证书路径错误")],
  readme: [activity("readme", 1, "对比 README 中英文段落"), activity("readme", 2, "补齐 3 处缺失段落"), activity("readme", 3, "校对术语表 12 条"), activity("readme", 4, "生成 diff 预览")],
  mobile: [activity("mobile", 1, "检查窄屏布局"), activity("mobile", 2, "styles.css +86 行", "edit"), activity("mobile", 3, "验证 390px 页面横向溢出…", "other", "running")],
  docs: [activity("docs", 1, "读取接口定义"), activity("docs", 2, "补充参数说明"), activity("docs", 3, "更新调用示例")],
  login: []
};
if (contentStress) Object.assign(activities, {
  "hello-deepseek": [], "markdown-reply": [], "hello-antigravity": [], "diagram": [],
  "markdown-tools": [
    activity("markdown-tools", 1, "cd /preview/freebuddy && head -40 handbook.md", "execute"),
    activity("markdown-tools", 2, "cd /preview/freebuddy && python3 - <<'PY'\nfrom pathlib import Path\nprint(Path('handbook.md').read_text())\nPY", "execute"),
    activity("markdown-tools", 3, "cd /preview/freebuddy && printf '\\n' >> handbook.md", "execute"),
    activity("markdown-tools", 4, "cd /preview/freebuddy && grep -n handbook handbook.md", "execute"),
    activity("markdown-tools", 5, "cd /preview/freebuddy && python3 - <<'PY'\nprint('check document')\nPY", "execute"),
    activity("markdown-tools", 6, "cd /preview/freebuddy && printf '\\n' >> handbook.md", "execute")
  ],
  "team-tools": ["mcp_freebuddy_skills_skill_list", "mcp_freebuddy_delegate_list_teammates", "mcp_freebuddy_skills_skill_load", "mcp_freebuddy_delegate_delegate", "mcp_freebuddy_delegate_yield_to_delegates"].map((target, index) => activity("team-tools", index, target)),
  ...Object.fromEntries(stressDefinitions.slice(6).map(([id]) => [id, []]))
});
const stressSummaries = {
  "hello-deepseek": "看起来你可能不太清楚能做什么。我简单说明一下：我是一个运行在你本地工作区的编程助手，可以直接读写文件、执行命令、搜索代码、访问网页。你可以直接用中文描述任务，例如帮我看看这个项目是做什么的、修复某个报错、写一个脚本批量重命名文件。当前工作区是空的还是有内容？可以先从一个具体任务开始。",
  "markdown-reply": "需要我做什么？直接说一下就行。",
  "hello-antigravity": "你好！有什么我可以帮你的吗？",
  "diagram": "基于同一份改造路径，时序图如下： ```mermaid sequenceDiagram autonumber participant C as Controller / Model participant OLD as Data_Boxxxx::getRowBywhere participant NEW as Data_Abstract 通用层 participant HS as Helper_Sqlstru C->>OLD: query OLD->>NEW: request NEW-->>C: result ```"
};
const overviews = Object.fromEntries(definitions.map(([id, , , , , status, model, minutes]) => [id, {
  conversationId: id, status, model, updatedAt: ago(minutes), taskId: `${id}-task`, activities: activities[id],
  attentionCount: status === "needs-input" ? 1 : undefined,
  summary: contentStress ? stressSummaries[id] ?? (id.startsWith("history-") ? "项目配置已记录，可以进入对话继续查看。" : undefined) : id === "login" ? "保留会话，随时继续讨论。上次回复：已整理两种登录流程。" : undefined
}]));
const subscribers = new Map<string, Set<(...args: unknown[]) => void>>();
const subscribe = (name: string, listener: (...args: unknown[]) => void) => {
  const callbacks = subscribers.get(name) || new Set(); callbacks.add(listener); subscribers.set(name, callbacks);
  return () => callbacks.delete(listener);
};
const emit = (name: string, ...args: unknown[]) => subscribers.get(name)?.forEach((listener) => listener(...args));
const detailItems = (id: string) => contentStress ? [
  ...(activities[id] ?? []).map((entry) => ({
    kind: "tool-call", id: entry.toolCallId, tool: entry.target, toolKind: entry.toolKind,
    status: entry.status, input: entry.toolKind === "execute" ? { command: entry.target } : undefined,
    locations: entry.filePath ? [{ path: entry.filePath }] : undefined
  })),
  { kind: "text", role: "assistant", content: stressSummaries[id] ?? "原始活动已保留，可在对话中查看完整内容。" }
] : [{ kind: "text", role: "assistant", content: "这是本地预览中的示例对话。任务面板展示的是独立会话的最近活动，点击列表可回到原来的侧边栏和对话。" }];
const listMessages = async (id: string) => ({ messages: [
  { id: `${id}-prompt`, conversationId: id, role: "user", status: "sent", content: conversations.find((entry) => entry.id === id)?.title || "演示任务", createdAt: ago(60), updatedAt: ago(60) },
  { id: `${id}-reply`, conversationId: id, role: "assistant", status: "done", content: JSON.stringify(detailItems(id)), createdAt: ago(1), updatedAt: ago(1) }
], hasMore: false });
const cliMethods = {
  listAdapters: async () => cliAdapterDefinitions,
  listOverrides: async () => [], listRuntimes: async () => [],
  listConversations: async () => conversations,
  listConversationOverviews: async (ids: string[]) => ids.map((id) => overviews[id]).filter(Boolean),
  listProjects: async () => projects, listMessages,
  listMessageFileEdits: async (id: string) => ({ edits: id === "signing-reply" ? [{ kind: "file-edit", path: "electron-builder.yml", action: "update", oldText: "win:\n  target: nsis\n", newText: "win:\n  target: nsis\n  certificateFile: ${CSC_LINK}\n" }] : [], nextCursor: 1, hasMore: false }),
  getConversation: async (id: string) => conversations.find((entry) => entry.id === id),
  getSetting: async (key: string) => ({ "language": "zh-CN", "theme": "light", "onboarding.state.v1": "skipped", "telemetry.enabled": "false" }[key] || null),
  setSetting: async () => undefined, ensureAgentGuides: async () => undefined,
  renameConversation: async (id: string, title: string) => { conversations = conversations.map((entry) => entry.id === id ? { ...entry, title, titleSource: "user" } : entry); emit("onConversationsChanged"); },
  deleteConversation: async (id: string) => { conversations = conversations.filter((entry) => entry.id !== id); emit("onConversationsChanged"); },
  archiveConversation: async (id: string) => { conversations = conversations.filter((entry) => entry.id !== id); emit("onConversationsChanged"); }
};
const cli = new Proxy(cliMethods, { get(target, key: string) { return target[key] || (key.startsWith("on") ? (listener) => subscribe(key, listener) : key.startsWith("list") ? async () => [] : async () => undefined); } });
let nativeFullscreen = false;
window.freebuddy = { platform: "darwin", appVersion: "0.10.25", cli, remote: { whoami: async () => ({ username: "preview", isOwner: true }) },
  settings: { getSetting: cliMethods.getSetting, setSetting: cliMethods.setSetting },
  infoCards: { list: async () => [], marketProvider: async () => undefined, listInstances: async () => [], onChanged: (listener) => subscribe("infoCardsChanged", listener) },
  plugins: { list: async () => [], onChanged: (listener) => subscribe("pluginsChanged", listener) },
  window: {
    onChromeVisible: (listener) => { listener(true); return subscribe("onChromeVisible", listener); },
    getFullscreenState: async () => nativeFullscreen,
    setFullscreen: async (value: boolean) => { nativeFullscreen = value; emit("onChromeVisible", !value); return true; },
    setUiPresence: () => undefined
  },
  debugLogs: { write: async () => undefined }
} as never;
localStorage.setItem("freebuddy.conversations.view.v1", "panel");
localStorage.setItem("freebuddy.conversations.unread.v1", JSON.stringify(contentStress ? {} : { readme: { kind: "success", at: ago(12) }, release: { kind: "message", at: ago(0) } }));
sessionStorage.setItem("fb_last_active_conversation", contentStress ? "markdown-tools" : "readme");
const { useConversationPanelUiStore } = await import("/src/store/conversationPanelUiStore.ts");
useConversationPanelUiStore.setState({ orderedIds: definitions.map(([id]) => id) });
await import("/src/main.tsx");
