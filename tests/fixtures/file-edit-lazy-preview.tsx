import { createRoot } from "react-dom/client";
import { useState } from "react";
import i18next from "../../src/i18n";
import "../../styles.css";
import { FileChangesCard, FileDiffPanel } from "../../src/components/CLI/FileChanges";
import { useConversationStore } from "../../src/store/conversationStore";
import { useFileDiffStore } from "../../src/store/fileDiffStore";
import type { CliStreamItem } from "../../src/services/cli/parsers";

void i18next.changeLanguage("zh-CN");
useConversationStore.setState({ activeId: "lazy-preview" });
const edits: Extract<CliStreamItem, { kind: "file-edit" }>[] = [
  { kind: "file-edit", path: "src/long-file.ts", action: "update", blobKey: "full" },
  { kind: "file-edit", path: "src/retry.ts", action: "create", blobKey: "retry" },
  { kind: "file-edit", path: "src/missing.ts", action: "update", blobKey: "missing" }
];
const baseline = 'const value = "完整的历史内容🙂";\n'.repeat(1200);
let requests = 0;
let failOnce = true;
const bridge = {
  async listMessageFileEdits() { return { edits, nextCursor: 3, hasMore: false }; },
  async readFileEditBlob(_conversationId: string, blobKey: string, offset = 0) {
    requests++;
    document.getElementById("request-count")!.textContent = String(requests);
    await new Promise(resolve => setTimeout(resolve, 350));
    if (blobKey === "retry" && failOnce) { failOnce = false; throw new Error("Preview failure"); }
    if (blobKey === "missing") return undefined;
    const content = blobKey === "full"
      ? { oldText: baseline + 'export const label = "旧文案";\n', newText: baseline + 'export const label = "新文案";\n' }
      : { newText: 'export const retry = "读取成功";\n' };
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    const page = bytes.slice(offset, offset + 65536);
    return { data: btoa(Array.from(page, byte => String.fromCharCode(byte)).join("")), nextOffset: offset + page.length, totalBytes: bytes.length, hasMore: offset + page.length < bytes.length };
  }
};
window.freebuddy = { cli: bridge, settings: { async setSetting() {} } } as unknown as typeof window.freebuddy;

function Preview() {
  const [hidden, setHidden] = useState(false);
  const selection = useFileDiffStore(state => state.selection);
  return <div style={{ display: "flex", height: "100dvh", background: "var(--fb-home-bg-primary)", color: "var(--fb-text-primary)" }}>
    <main style={{ flex: 1, padding: 32 }}>
      <h2>文件变更按需加载</h2>
      <p>正文请求次数：<span id="request-count">0</span></p>
      <p>消息中的 diff 已被截断淘汰，以下卡片从独立索引恢复。</p>
      <FileChangesCard items={[]} conversationId="lazy-preview" messageId="message" storedTaskId="run" />
      <button onClick={() => { setHidden(!hidden); useConversationStore.setState({ activeId: hidden ? "lazy-preview" : "other" }); }}>切换会话</button>
    </main>
    {selection && <aside style={{ width: "60%", minWidth: 360 }}><FileDiffPanel /></aside>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
