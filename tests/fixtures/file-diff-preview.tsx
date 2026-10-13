// Local-only visual fixture: npx vite, then /tests/fixtures/file-diff-preview.html.
// Uses in-memory state and never starts agents or writes conversation data.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import i18next from "../../src/i18n";
import "../../styles.css";
import { FileChangesCard } from "../../src/components/CLI/FileChanges";
import { DetailColumn } from "../../src/components/CLI/DetailColumn";
import { useConversationStore } from "../../src/store/conversationStore";
import { useDetailLayoutStore, selectDetailWidth } from "../../src/store/detailLayoutStore";
import { useBrowserStore } from "../../src/store/browserStore";
import type { CliStreamItem } from "../../src/services/cli/parsers";

void i18next.changeLanguage("zh-CN");
useConversationStore.setState({ activeId: "diff-fixture" });
useDetailLayoutStore.setState({ activeTab: "overview", detailCollapsed: true });
useBrowserStore.setState({ byConv: { "diff-fixture": { cwd: "", ready: true, manualEntry: "http://127.0.0.1:5173/tests/fixtures/file-diff-browser.html", url: "http://127.0.0.1:5173/tests/fixtures/file-diff-browser.html", history: [], historyIndex: -1, reloadNonce: 0, loadState: "idle", updatedAt: "" } } });
const context = Array.from({ length: 16 }, (_, i) => `// unchanged context ${i + 1}`).join("\n");
const items: CliStreamItem[] = [
  { kind: "file-edit", path: "src/Login.tsx", action: "update", oldText: `export function Login() {\n  const label = "登录";\n${context}\n  return <button>{label}</button>;\n}\n`, newText: `export function Login() {\n  const label = "立即登录";\n  const disabled = false;\n${context}\n  return <button disabled={disabled}>{label}</button>;\n}\n` },
  { kind: "file-edit", path: "src/login.css", action: "create", newText: ".login {\n  display: flex;\n  gap: 12px;\n}\n" },
  { kind: "file-edit", path: "src/legacy.ts", action: "delete", oldText: "export const legacy = true;\n" },
  { kind: "file-edit", path: "assets/logo.png", action: "update" },
  { kind: "file-edit", path: "assets/icon.svg", action: "update", oldText: "<svg />", newText: "<svg viewBox=\"0 0 24 24\" />" },
  { kind: "file-edit", path: "assets/font.woff2", action: "create" },
  { kind: "file-edit", path: "assets/video.mp4", action: "create" },
  { kind: "file-edit", path: "src/large.ts", action: "update", truncated: true, oldText: "before", newText: "after" }
];
const loginEdit = items[0] as Extract<CliStreamItem, { kind: "file-edit" }>;
items.push({ ...loginEdit, oldText: loginEdit.newText, newText: loginEdit.newText!.replace("立即登录", "继续登录") });
items.push({ kind: "file-edit", path: "src/reverted.ts", action: "update", oldText: "original", newText: "temporary" });
items.push({ kind: "file-edit", path: "src/reverted.ts", action: "update", oldText: "temporary", newText: "original" });
function Preview() {
  const [running, setRunning] = useState(true);
  const [resourcesOnly, setResourcesOnly] = useState(false);
  const collapsed = useDetailLayoutStore((s) => s.detailCollapsed);
  const width = useDetailLayoutStore(selectDetailWidth);
  const activeId = useConversationStore((s) => s.activeId);
  return <div style={{ display: "flex", height: "100dvh", background: "var(--fb-home-bg-primary)", color: "var(--fb-text-primary)" }}>
    <main style={{ flex: 1, minWidth: 0, padding: 32, overflow: "auto" }}>
      <h2>普通对话 · 文件变更验证</h2>
      <p>登录文件在同一轮修改了两次；点击后显示整体差异。reverted.ts 改后恢复，打开确认后从卡片隐藏。</p>
      <button onClick={() => setRunning(!running)}>{running ? "结束本轮对话" : "模拟新一轮执行"}</button>
      <button onClick={() => { setRunning(false); setResourcesOnly(value => !value); }}>{resourcesOnly ? "文本与资源混合" : "仅资源变化"}</button>
      <p>状态：{running ? "运行中" : "已结束"}</p>
      <FileChangesCard items={resourcesOnly ? items.filter(item => item.kind === "file-edit" && item.path.startsWith("assets/")) : items} conversationId="diff-fixture" messageId="message-1" isRunning={running} />
      <button onClick={() => useConversationStore.setState({ activeId: activeId === "other-fixture" ? "diff-fixture" : "other-fixture" })}>切换测试会话</button>
      <button onClick={() => useDetailLayoutStore.getState().setDetailCollapsed(false)}>打开侧栏</button>
      <p>当前会话：{activeId}</p>
    </main>
    {!collapsed && <div style={{ display: "flex", width, minWidth: 320 }}><DetailColumn runningCount={0} /></div>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
