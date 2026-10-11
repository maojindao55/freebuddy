// Local-only visual fixture: npx vite, then /tests/fixtures/doc-studio-preview.html.
// Renders the production DocStudioApp / ButlerBuddyChat with an in-memory window.freebuddy.
// URL params:
//   theme=light|dark   view=sheet|empty|markdown|butler   chat=1   lang=zh-CN|en
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import i18next from "../../src/i18n";
import "../../styles.css";
import "../../src/components/DocStudio/docStudio.css";
import type { Conversation, ConversationMessage } from "../../src/services/cli/types";
import { useConversationStore } from "../../src/store/conversationStore";

const params = new URLSearchParams(location.search);
void i18next.changeLanguage(params.get("lang") === "en" ? "en" : "zh-CN");
const theme = params.get("theme") === "dark" ? "dark" : "light";
const view = params.get("view") || "sheet";
const withChat = params.get("chat") === "1";
const liveMode = params.get("live") === "1";
const extMode = params.get("ext") === "1";
const streamMode = params.get("stream") === "1";
const copilotWidthParam = params.get("copilotWidth");
if (copilotWidthParam) localStorage.setItem("docStudio.copilotWidth", copilotWidthParam);

document.documentElement.dataset.theme = theme;
document.documentElement.dataset.surface = view === "butler" ? "butler-chat" : "doc-studio";

// ---------- fixture data ----------
const SHEET_FILE = "/Users/demo/Documents/微博播放数据.csv";
const MD_FILE = "/Users/demo/Documents/发布说明.md";

const CSV = [
  "日期,类型,播放人数,播放量,播放时长/分钟,分端,位置",
  "2025-11-01,微博视频,124530,356789,1823455,移动端,信息流",
  "2025-11-02,微博视频,118762,340112,1701290,移动端,信息流",
  "2025-11-03,微博视频,131008,389654,2015667,PC端,详情页",
  "2025-11-04,微博视频,109877,301245,1490872,移动端,信息流",
  "2025-11-05,微博视频,142390,412078,2204913,移动端,搜索页",
  "2025-11-06,微博视频,155216,450991,2387445,PC端,详情页",
  "2025-11-07,微博视频,160845,468320,2501988,移动端,信息流",
  "2025-11-08,微博视频,149332,431705,2289064,移动端,信息流",
  "2025-11-09,微博视频,137519,398846,2094331,PC端,搜索页",
  "2025-11-10,微博视频,128760,372519,1956207,移动端,信息流",
  "2025-11-11,微博视频,171204,502377,2688450,移动端,信息流",
  "2025-11-12,微博视频,183966,541830,2901772,移动端,信息流",
  "2025-11-13,微博视频,175408,516942,2765330,PC端,详情页",
  "2025-11-14,微博视频,166871,489205,2610948,移动端,信息流",
  "2025-11-15,微博视频,158209,463788,2472661,移动端,搜索页"
].join("\n");

const MD = `# FreeBuddy 2.4 发布说明

## 亮点

- 新增 **DocStudio** 独立文档窗口,支持 CSV / Excel / Markdown
- ButlerBuddy 悬浮助手支持多会话与模型切换
- 远程访问(Remote Access)进入 Beta

## 修复

1. 修复会话列表偶发不刷新的问题
2. 修复暗色主题下代码块对比度不足

> 升级前请先备份 ~/.freebuddy 配置目录。
`;

const assistantText = [
  "已读取该表格,共 15 行、7 列。核心结论如下:",
  "",
  "- **播放量峰值**出现在 11-12(541,830),与双十一活动周期吻合;",
  "- **移动端占比约 78%**,信息流是最主要的流量入口;",
  "- 播放时长与播放量相关系数约 0.98,呈现强线性关系。",
  "",
  "| 指标 | 总量 | 日均 | 峰值 |",
  "| --- | --- | --- | --- |",
  "| 播放量 | 6,381,727 | 425,448 | 541,830 |",
  "| 播放人数 | 2,190,237 | 146,016 | 183,966 |",
  "| 播放时长/分钟 | 33,895,723 | 2,259,715 | 2,901,772 |",
  "",
  "建议后续重点投放移动端信息流位,并在活动前 48 小时预热。",
  "",
  "另外建议新增一列“日均播放量系数”,例如:",
  "",
  "```json",
  "{",
  "  \"updates\": [",
  "    { \"cell\": \"H2\", \"value\": 2.86, \"formula\": \"=D2/C2\" },",
  "    { \"cell\": \"H3\", \"value\": 2.86, \"formula\": \"=D3/C3\" }",
  "  ]",
  "}",
  "```"
].join("\n");

const now = new Date().toISOString();
const convId = "fixture-doc-conv";

const seededConversation: Conversation = {
  id: convId,
  title: view === "markdown" ? "发布说明.md" : "微博播放数据.csv",
  agentId: "cli-butlerbuddy",
  agentName: "ButlerBuddy",
  adapter: "codex-acp",
  skillSnapshot: [],
  archived: false,
  createdAt: now,
  updatedAt: now,
  lastMessageAt: now
};

const butlerConversation: Conversation = {
  ...seededConversation,
  id: "fixture-butler-conv",
  title: "ButlerBuddy",
  kind: undefined
};

const makeMessages = (conversationId: string): ConversationMessage[] => [
  {
    id: `${conversationId}-m1`,
    conversationId,
    role: "user",
    status: "done",
    content: "帮我整体分析一下这份数据,有什么值得注意的趋势?",
    createdAt: now,
    updatedAt: now
  },
  {
    id: `${conversationId}-m2`,
    conversationId,
    role: "assistant",
    status: "done",
    agentId: "cli-butlerbuddy",
    agentName: "ButlerBuddy",
    adapter: "codex-acp",
    content: JSON.stringify([
      { kind: "session", sessionId: "fixture-session-1", title: "DocStudio" },
      {
        kind: "config-options",
        options: [
          {
            id: "provider",
            name: "Provider",
            category: "provider",
            currentValue: "openai",
            values: [
              { id: "openai", name: "OpenAI" },
              { id: "azure", name: "Azure OpenAI" }
            ]
          },
          {
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "gpt-5.3-codex",
            values: [
              { id: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
              { id: "gpt-5.2-codex", name: "GPT-5.2 Codex" },
              { id: "gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" }
            ]
          }
        ]
      },
      { kind: "text", role: "assistant", content: assistantText }
    ]),
    createdAt: now,
    updatedAt: now
  }
];

// live=1: the assistant message is returned mid-stream ("running"); the
// fixture flips it to "done" after render so auto-apply fires.
const liveAssistantText = [
  "已在当前表格中新增“日均播放量”和“互动率”两列,并完成 14 条数据的填充。",
  "",
  "```json",
  "{",
  "  \"updates\": [",
  `    { "cell": "H1", "value": "日均播放量" },`,
  `    { "cell": "I1", "value": "互动率" },`,
  CSV.split("\n")
    .slice(1)
    .map((row, i) => {
      const plays = Number(row.split(",")[3]);
      const users = Number(row.split(",")[2]);
      // Column H uses the formula-only shape the user hit in the real app.
      return [
        `    { "cell": "H${i + 2}", "formula": "=IFERROR(ROUND(D${i + 2}/30,0),\\"\\")" },`,
        `    { "cell": "I${i + 2}", "value": ${(plays / users / 100).toFixed(2)} }`
      ].join("\n");
    })
    .join(",\n"),
  "  ]",
  "}",
  "```"
].join("\n");

const liveMessages = (conversationId: string): ConversationMessage[] => {
  const msgs = makeMessages(conversationId);
  msgs[1] = {
    ...msgs[1],
    status: "running",
    content: JSON.stringify([{ kind: "text", role: "assistant", content: liveAssistantText }])
  };
  return msgs;
};

// stream=1: assistant message mid-stream with an UNCLOSED ```json updates fence.
const streamMessages = (conversationId: string): ConversationMessage[] => {
  const msgs = makeMessages(conversationId);
  msgs[1] = {
    ...msgs[1],
    status: "running",
    content: JSON.stringify([
      {
        kind: "text",
        role: "assistant",
        content:
          "正在为表格生成修改…\n\n```json\n{\n  \"updates\": [\n    { \"cell\": \"H1\", \"value\": \"日均播放量\" },"
      }
    ])
  };
  return msgs;
};

// ---------- window.freebuddy mock ----------
const settingsMap: Record<string, string | null> = {
  "butlerbuddy.petConversationId": butlerConversation.id,
  "docStudio.conversationByFile": JSON.stringify({ [SHEET_FILE]: convId, [MD_FILE]: convId }),
  "docStudio.agentId": "cli-butlerbuddy",
  theme,
  language: params.get("lang") === "en" ? "en" : "zh-CN"
};

let csvContent = CSV;
const watchedFiles = new Set<string>();
let fileChangedCb: ((filePath: string) => void) | null = null;

const readFile = async (filePath: string) => {
  const ext = filePath.endsWith(".md") ? ".md" : ".csv";
  const content = ext === ".md" ? MD : csvContent;
  return {
    success: true,
    name: filePath.split("/").pop(),
    path: filePath,
    size: content.length,
    ext,
    content
  };
};

const settingsStub = {
  getSetting: async (key: string) => settingsMap[key] ?? null,
  setSetting: async (key: string, value: string) => {
    settingsMap[key] = value;
  }
};

const cliMethodOverrides: Record<string, unknown> = {
  getSetting: settingsStub.getSetting,
  setSetting: settingsStub.setSetting,
  listAdapters: async () => [],
  listOverrides: async () => [],
  listRuntimes: async () => [
    { adapter: "codex-acp", installed: true, lastCheckAt: now, updateCheckSupported: false },
    { adapter: "pi-acp", installed: true, lastCheckAt: now, updateCheckSupported: false }
  ],
  check: async () => ({ ok: true }),
  listProjects: async () => [],
  listConversationContextReferences: async () => [],
  listFollowupMessages: async () => [],
  onRuntimeUpdated: () => () => {},
  listConversations: async () =>
    view === "butler"
      ? [butlerConversation]
      : withChat || liveMode || extMode || streamMode
        ? [seededConversation]
        : [],
  createConversation: async (input: Partial<Conversation>) => ({
    ...seededConversation,
    ...input,
    id: input.id || `fixture-conv-${Date.now()}`,
    skillSnapshot: [],
    archived: false,
    createdAt: now,
    updatedAt: now
  }),
  listMessages: async (conversationId: string) => ({
    messages:
      streamMode && conversationId === convId
        ? streamMessages(conversationId)
        : liveMode && conversationId === convId
          ? liveMessages(conversationId)
          : withChat && (conversationId === convId || conversationId === butlerConversation.id)
            ? makeMessages(conversationId)
            : [],
    hasMore: false
  }),
  ensureAgentGuides: async () => {},
  getCachedSessionConfigOptions: async () => [],
  inspectSessionConfigOptions: async () => []
};

const cliStub = new Proxy(cliMethodOverrides, {
  get(target, prop: string) {
    if (prop === "settings") {
      return settingsStub;
    }
    if (prop in target) return target[prop];
    return async () => undefined;
  }
});

window.freebuddy = {
  platform: "darwin",
  arch: "arm64",
  versions: {},
  appVersion: "2.4.0-fixture",
  cli: cliStub,
  settings: settingsStub,
  plugins: {
    list: async () => ({ plugins: [], marketplaces: [] }),
    install: async () => ({ ok: true }),
    update: async () => ({ ok: true }),
    uninstall: async () => ({ ok: true }),
    addMarketplace: async () => ({ ok: true }),
    updateMarketplace: async () => ({ ok: true }),
    removeMarketplace: async () => ({ ok: true })
  },
  docStudio: {
    openWindow: async () => true,
    readFile,
    writeFile: async () => ({ success: true }),
    showSaveDialog: async () => null,
    showOpenDialog: async () => null,
    showItemInFolder: async () => true,
    openConversationInMain: async () => true,
    watchFile: async (p: string) => {
      watchedFiles.add(p);
      return true;
    },
    unwatchFile: async (p: string) => {
      watchedFiles.delete(p);
      return true;
    },
    getEnginePreview: async () => ({
      success: true,
      url: "http://127.0.0.1:39100/static/doc/pc.html?localFilePath=fixture"
    }),
    getEngineEditorStatus: async () => ({
      success: true,
      isDirty: false,
      lastSavedMs: 0
    }),
    onFileChanged: (cb: (filePath: string) => void) => {
      fileChangedCb = cb;
      return () => {
        fileChangedCb = null;
      };
    }
  },
  butlerBuddy: {
    beginDrag: () => {},
    endDrag: () => {},
    hideChat: () => {},
    getPreferences: async () => undefined,
    onNewConversation: () => () => {}
  },
  window: {
    onAppearanceChanged: () => () => {},
    broadcastTheme: () => {}
  },
  remote: {
    whoami: async () => null
  },
  debugLogs: {
    write: async () => {}
  }
} as never;

// Seed conversation store before render so the copilot/chat have history.
(window as any).__convStore = useConversationStore;
const activeConv = view === "butler" ? butlerConversation : seededConversation;
useConversationStore.setState({
  conversations: [activeConv],
  messages:
    liveMode && view === "sheet"
      ? { [activeConv.id]: liveMessages(activeConv.id) }
      : streamMode && view === "sheet"
        ? { [activeConv.id]: streamMessages(activeConv.id) }
        : withChat
          ? { [activeConv.id]: makeMessages(activeConv.id) }
          : {},
  activeId: view === "butler" ? activeConv.id : undefined
});

async function render() {
  const { StrictMode } = await import("react");
  const { ErrorBoundary } = await import("../../src/components/ErrorBoundary");
  let node: ReactNode;
  if (view === "butler") {
    const { ButlerBuddyChat } = await import("../../src/components/ButlerBuddy/ButlerBuddyChat");
    node = <ButlerBuddyChat />;
  } else {
    const { DocStudioApp } = await import("../../src/components/DocStudio/DocStudioApp");
    const file =
      view === "sheet" ? SHEET_FILE : view === "markdown" ? MD_FILE : undefined;
    node = <DocStudioApp initialFilePath={file} />;
  }
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <ErrorBoundary>{node}</ErrorBoundary>
    </StrictMode>
  );
}

void render();

// live=1: flip the seeded running assistant message to done so the copilot
// auto-applies its updates block (which adds 2 new columns).
if (liveMode && view === "sheet") {
  setTimeout(() => {
    useConversationStore.setState((s) => ({
      messages: {
        ...s.messages,
        [convId]: (s.messages[convId] ?? liveMessages(convId)).map((m) =>
          m.id.endsWith("-m2") ? { ...m, status: "done" } : m
        )
      }
    }));
  }, 2000);
}

// ext=1: simulate an external file modification followed by a fileChanged event.
if (extMode && view === "sheet") {
  setTimeout(() => {
    const lines = csvContent.split("\n");
    csvContent = lines
      .map((l, i) => (i === 0 ? `${l},外部新增` : `${l},ext-${i}`))
      .join("\n");
    fileChangedCb?.(SHEET_FILE);
  }, 1200);
}
