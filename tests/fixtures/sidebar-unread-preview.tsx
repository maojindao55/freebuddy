// Local-only visual fixture: npx vite, then /tests/fixtures/sidebar-unread-preview.html.
// Uses real sidebar components with in-memory data; never starts agents or writes tasks.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, Moon, RotateCcw, Sun } from "lucide-react";
import i18next from "../../src/i18n";
import "../../styles.css";
import sidebarLogoUrl from "../../assets/sidebar-logo.png";
import { ConversationList } from "../../src/components/CLI/ConversationList";
import { SidebarNavigation, type WorkspaceView } from "../../src/components/CLI/SidebarNavigation";
import { useConversationStore } from "../../src/store/conversationStore";
import { useProjectStore } from "../../src/store/projectStore";
import { usePinnedProjectsStore } from "../../src/store/pinnedProjectsStore";
import { useWorkflowStore } from "../../src/store/workflowStore";
import type { Conversation, Project } from "../../src/services/cli/types";
import type { UnreadConversationMap } from "../../src/store/conversationUnread";

void i18next.changeLanguage("zh-CN");

const timestamp = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 2, 7, 30) - minutesAgo * 60_000).toISOString();
const project = (id: string, name: string, folder: string): Project => ({
  id, name, folders: [folder], primaryPath: folder, createdAt: timestamp(300), updatedAt: timestamp(0)
});
const projects = [
  project("freebuddy", "FreeBuddy", "/Users/demo/www/freebuddy"),
  project("design-system", "设计系统", "/Users/demo/www/design-system"),
  project("docs", "文档站", "/Users/demo/www/docs")
];
const conversation = (id: string, title: string, minutesAgo: number, extras: Partial<Conversation> = {}): Conversation => ({
  id, title, titleSource: "user", agentId: "codex", agentName: "Codex", adapter: "codex",
  archived: false, skillSnapshot: [], createdAt: timestamp(400), updatedAt: timestamp(minutesAgo),
  lastMessageAt: timestamp(minutesAgo), ...extras
});
const seedConversations = (): Conversation[] => [
  conversation("freebuddy-result", "登录页面的交互优化已完成", 0, { projectId: "freebuddy", cwd: projects[0].primaryPath }),
  conversation("running-task", "为文件预览补充回归测试", 1, { projectId: "freebuddy", cwd: projects[0].primaryPath }),
  conversation("current-task", "侧边栏未读筛选", 3, { projectId: "freebuddy", cwd: projects[0].primaryPath }),
  conversation("cwd-only-result", "修复项目目录识别", 20, { cwd: projects[0].primaryPath }),
  conversation("design-result", "按钮组件的状态与动效", 2, { projectId: "design-system", cwd: projects[1].primaryPath, adapter: "claude", agentName: "Claude" }),
  conversation("design-read", "整理基础颜色与间距", 6, { projectId: "design-system", cwd: projects[1].primaryPath, adapter: "claude", agentName: "Claude" }),
  conversation("docs-read", "更新快速开始文档", 7, { projectId: "docs", cwd: projects[2].primaryPath }),
  conversation("orphan-result", "恢复未归档的历史任务", 5, { projectId: "removed-project" }),
  ...[
    "整理这周的产品反馈", "排查本地开发环境", "优化任务标题显示", "检查图片加载表现", "起草版本更新说明",
    "整理键盘快捷键", "检查消息列表滚动", "研究窗口布局细节", "回顾第一次用户访谈"
  ].map((title, index) => conversation(`recent-read-${index + 1}`, title, 8 + index)),
  // Below the default eight recent rows: filtering must happen before truncation.
  conversation("old-recent-result", "上周的无障碍检查结果", 90)
];
const seedUnread = (): UnreadConversationMap => ({
  "freebuddy-result": { kind: "success", at: timestamp(0) },
  "design-result": { kind: "message", at: timestamp(2) },
  "cwd-only-result": { kind: "success", at: timestamp(20) },
  "orphan-result": { kind: "failure", at: timestamp(5) },
  "old-recent-result": { kind: "message", at: timestamp(90) }
});

function seed() {
  useConversationStore.setState({
    conversations: seedConversations(), activeId: "current-task", unreadConversations: seedUnread(),
    currentUser: { username: "Hongbin", isOwner: true }, messages: {},
    live: { "running-task": { messageId: "running-message", taskSessionId: "running-session", items: [], status: "running" } }
  });
  useProjectStore.setState({ projects: projects.map(item => ({ ...item, folders: [...item.folders] })), loaded: true, loading: false, error: undefined });
  usePinnedProjectsStore.setState({ pinnedKeys: ["freebuddy"] });
}

function markRead(id: string | undefined) {
  useConversationStore.setState(state => {
    const unreadConversations = { ...state.unreadConversations };
    if (id) delete unreadConversations[id];
    return { activeId: id, unreadConversations };
  });
}

// Replace sidebar mutations and loaders before mounting. No native bridge is needed.
useConversationStore.setState({
  setActive: async id => { markRead(id); },
  refreshList: async () => {},
  renameConversation: async (id, title) => {
    useConversationStore.setState(state => ({ conversations: state.conversations.map(item => item.id === id ? { ...item, title, titleSource: "user" } : item) }));
  },
  deleteConversation: async id => {
    useConversationStore.setState(state => {
      const unreadConversations = { ...state.unreadConversations };
      delete unreadConversations[id];
      return { conversations: state.conversations.filter(item => item.id !== id), unreadConversations, activeId: state.activeId === id ? undefined : state.activeId };
    });
  }
});
useProjectStore.setState({ refresh: async () => {} });
useWorkflowStore.setState({ activeRuns: [], loadActiveRuns: async () => {} });
usePinnedProjectsStore.setState({
  toggle: key => usePinnedProjectsStore.setState(state => ({ pinnedKeys: state.pinnedKeys.includes(key) ? state.pinnedKeys.filter(item => item !== key) : [key, ...state.pinnedKeys] })),
  unpin: key => usePinnedProjectsStore.setState(state => ({ pinnedKeys: state.pinnedKeys.filter(item => item !== key) }))
});
seed();

function Preview() {
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [language, setLanguage] = useState<"zh-CN" | "en">("zh-CN");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>("chat");
  const active = useConversationStore(state => state.conversations.find(item => item.id === state.activeId));
  const currentUser = useConversationStore(state => state.currentUser);
  const unreadCount = useConversationStore(state => state.conversations.filter(item => !!state.unreadConversations[item.id]).length);
  const running = useConversationStore(state => active ? state.live[active.id]?.status === "running" : false);
  const english = language === "en";

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const newTask = () => { markRead(undefined); setWorkspaceView("chat"); };
  const simulateActivity = () => {
    const id = "docs-latest-activity";
    useConversationStore.setState(state => ({
      conversations: [
        conversation(id, "Latest documentation activity", -1, { projectId: "docs", cwd: projects[2].primaryPath }),
        ...state.conversations.filter(item => item.id !== id)
      ],
      unreadConversations: { ...state.unreadConversations, [id]: { kind: "message", at: timestamp(-1) } }
    }));
  };
  const addProject = () => useProjectStore.setState(state => ({
    projects: state.projects.some(item => item.id === "new-project")
      ? state.projects
      : [...state.projects, project("new-project", "New project", "/Users/demo/www/new-project")]
  }));

  return <div className="app-shell detail-collapsed" data-theme={theme}>
    <style>{`
      .unread-fixture-main { min-width: 0; overflow: auto; background: var(--fb-home-bg-primary); }
      .unread-fixture-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 66px; padding: 14px 26px; border-bottom: 1px solid var(--fb-border); }
      .unread-fixture-toolbar button { display: inline-flex; align-items: center; gap: 6px; padding: 6px 9px; border: 1px solid var(--fb-border); border-radius: 7px; background: transparent; color: var(--fb-text-secondary); font-size: 12px; }
      .unread-fixture-toolbar button:hover { background: var(--fb-hover); color: var(--fb-text-primary); }
      .unread-fixture-meta { margin-right: auto; color: var(--fb-text-secondary); font-size: 12px; }
      .unread-fixture-content { max-width: 780px; margin: 0 auto; padding: 58px 40px; }
      .unread-fixture-content h2 { margin: 10px 0 32px; font-size: 24px; font-weight: 600; letter-spacing: -.5px; }
      .unread-fixture-label { color: var(--fb-text-secondary); font-size: 12px; }
      .unread-fixture-message { margin: 26px 0; line-height: 1.85; font-size: 14px; }
      .unread-fixture-status { display: inline-flex; align-items: center; gap: 6px; color: var(--fb-text-secondary); font-size: 12px; }
      .unread-fixture-note { margin-top: 58px; padding-top: 18px; border-top: 1px solid var(--fb-border); color: var(--fb-text-secondary); font-size: 12px; line-height: 1.8; }
    `}</style>
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <span className="sidebar-logo" aria-hidden="true"><img className="sidebar-logo-img" src={sidebarLogoUrl} alt="" /></span>
          <div className="sidebar-brand-text"><div className="sidebar-brand-row"><h1>FreeBuddy</h1><span className="sidebar-dev-badge">DEV</span></div></div>
        </div>
      </div>
      <SidebarNavigation workspaceView={workspaceView} isNewTask={!active} onNewTask={newTask} onOpenScheduledTasks={() => setWorkspaceView("scheduledTasks")} onOpenTeams={() => setWorkspaceView("workflowTeams")} onOpenFreebie={() => setWorkspaceView("freebie")} />
      <ConversationList onNewTaskInProject={newTask} />
      <div className="sidebar-footer"><span className="sidebar-user-name">{currentUser?.username}</span><span className="footer-version">v0.10.24</span></div>
    </aside>
    <main className="unread-fixture-main">
      <div className="unread-fixture-toolbar" aria-label="Preview controls">
        <span className="unread-fixture-meta" data-testid="unread-count">{english ? `${unreadCount} unread tasks` : `${unreadCount} 个未读任务`}</span>
        <button type="button" onClick={() => { seed(); setWorkspaceView("chat"); }}><RotateCcw size={13} />{english ? "Reset sample" : "重置示例"}</button>
        <button type="button" onClick={() => useConversationStore.setState({ unreadConversations: {} })}><Check size={13} />{english ? "Clear unread" : "清空未读"}</button>
        <button type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>{theme === "light" ? <Moon size={13} /> : <Sun size={13} />}{english ? "Theme" : "切换主题"}</button>
        <button type="button" onClick={() => { const next = english ? "zh-CN" : "en"; setLanguage(next); document.documentElement.lang = next; void i18next.changeLanguage(next); }}>{english ? "中文" : "English"}</button>
        <button type="button" onClick={simulateActivity}>Simulate project activity</button>
        <button type="button" onClick={addProject}>Add sample project</button>
        <button type="button" onClick={() => useConversationStore.setState({ currentUser: { username: currentUser?.username === "Hongbin" ? "OtherUser" : "Hongbin", isOwner: true } })}>Switch sample user</button>
      </div>
      <div className="unread-fixture-content">
        <div className="unread-fixture-label">{active?.projectId === "freebuddy" ? "FreeBuddy" : english ? "Workspace" : "工作区"} / {english ? "Task" : "任务"}</div>
        <h2>{active?.title ?? (english ? "Start a new task" : "开始新任务")}</h2>
        <div className="unread-fixture-status"><Check size={14} />{running ? (english ? "Working" : "执行中") : (english ? "Up to date" : "已查看最新消息")}</div>
        <div className="unread-fixture-message">
          <strong>Codex</strong>
          <p>{english ? "The sidebar keeps unread work within its project context. Select a task to read the latest result; the open task remains here while its unread indicator is cleared." : "侧边栏保留项目分组，方便找到需要查看的任务。选择一个任务即可阅读最新结果；已打开的内容会保留在这里，未读状态随之清除。"}</p>
        </div>
        <div className="unread-fixture-note">
          {english ? "Preview data includes a running task, a project with only read tasks, a task linked by its folder, a missing project, and an older unread task beyond the initial recent list." : "示例包含执行中的已读任务、仅含已读任务的项目、通过目录归组的任务、原项目已移除的任务，以及最近列表第八条之后的较早未读任务。"}
        </div>
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<Preview />);
