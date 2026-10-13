// Local UI fixture only. The snapshot database and runtime are tested separately.
import { createRoot } from "react-dom/client";
import { useState } from "react";
import i18next from "../../src/i18n";
import "../../styles.css";
import { FileChangesCard, FileDiffPanel } from "../../src/components/CLI/FileChanges";
import { useConversationStore } from "../../src/store/conversationStore";
import { useFileDiffStore } from "../../src/store/fileDiffStore";
import type { CliStreamItem, FileEditPage } from "@freebuddy/protocol";

void i18next.changeLanguage("zh-CN");
useConversationStore.setState({ activeId: "snapshot-preview" });
const before = "# 测试文档\n\n第一行：内容已更改。\n\n第二行：这是第二次追加的内容。\n\n新增行：这是新添加的一行。\n";
const after = "# 测试文档\n\n第一行：第一次修改完成（1/3）。\n\n第二行：第二次修改完成（2/3）。\n\n新增行：第三次修改完成（3/3）。\n";
const items: CliStreamItem[] = [
  { kind: "file-edit", path: "test.md", action: "update", partial: true, oldText: "第一行：内容已更改。", newText: "第一行：第一次修改完成（1/3）。" },
  { kind: "file-edit", path: "reverted.md", action: "update", oldText: "original", newText: "temporary" }
];
let quality = "ready";
let finalizing = false;
window.freebuddy = { cli: {
  async listMessageFileEdits(_messageId: string, cursor = 0): Promise<FileEditPage> {
    await new Promise(resolve => setTimeout(resolve, 50));
    const pending = finalizing; finalizing = false;
    return { edits: pending || quality === "zero" ? [] : [
      { kind: "file-edit", path: "test.md", action: "update", turnKey: `test-${quality}`, source: quality === "partial" ? "records" : "snapshot", overlapping: quality === "overlap" },
      ...(quality === "partial" ? [] : [{ kind: "file-edit" as const, path: "empty.md", action: "create" as const, turnKey: "empty", source: "snapshot" as const }])
    ], coveredPaths: ["test.md", "reverted.md"], nextCursor: cursor, hasMore: false,
      capture: { state: pending ? "finalizing" : quality === "partial" ? "incomplete" : "ready", complete: quality !== "partial", overlapping: quality === "overlap" } };
  },
  async readMessageFileEdit(_messageId: string, _path: string, key: string, offset = 0) {
    const content = key === "empty" ? { source: "snapshot", action: "create", oldText: "", newText: "" }
      : key.endsWith("partial") ? { source: "records", action: "update", oldText: "第一行：内容已更改。", newText: "第一行：第一次修改完成（1/3）。", partial: true }
      : { source: "snapshot", action: "update", oldText: before, newText: after, partial: false };
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    const page = bytes.slice(offset, offset + 65536);
    return { data: btoa(Array.from(page, byte => String.fromCharCode(byte)).join("")), nextOffset: offset + page.length, totalBytes: bytes.length, hasMore: offset + page.length < bytes.length };
  }
}, settings: { async setSetting() {} } } as unknown as typeof window.freebuddy;

function Preview() {
  const [running, setRunning] = useState(true);
  const [version, setVersion] = useState(0);
  const [narrow, setNarrow] = useState(false);
  const selection = useFileDiffStore(state => state.selection);
  const switchQuality = (value: string) => { quality = value; setRunning(false); setVersion(value => value + 1); useFileDiffStore.setState({ selection: undefined }); };
  return <div style={{ display: "flex", height: "100dvh", background: "var(--fb-home-bg-primary)", color: "var(--fb-text-primary)", overflow: "hidden" }}>
    <main style={{ flex: 1, minWidth: 0, padding: 24, overflow: "auto" }}>
      <h2>轮次快照 · 组件验证</h2>
      <p>同轮三处修改；改后恢复的文件在索引发布时排除。</p>
      <div style={{ display: "flex", gap: 12, margin: "18px 0", flexWrap: "wrap" }}>
        <button onClick={() => switchQuality("ready")}>结束本轮</button>
        <button onClick={() => switchQuality("zero")}>无净变化</button>
        <button onClick={() => switchQuality("partial")}>不完整记录</button>
        <button onClick={() => switchQuality("overlap")}>并行任务</button>
        <button onClick={() => { finalizing = true; switchQuality("ready"); }}>封存中</button>
        <button onClick={() => setNarrow(value => !value)}>窄侧栏</button>
      </div>
      <FileChangesCard items={items} conversationId="snapshot-preview" messageId={`snapshot-message-${version}`} storedTaskId={`run-${version}`} isRunning={running} />
    </main>
    {selection && <aside style={{ display: "flex", flex: "0 1 auto", width: narrow ? 360 : 680, minWidth: 0, padding: 16, borderLeft: "1px solid var(--fb-border)" }}><FileDiffPanel /></aside>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
