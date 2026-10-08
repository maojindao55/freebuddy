import { createRoot } from "react-dom/client";
import { useState } from "react";
import i18next from "../../src/i18n";
import "../../styles.css";
import { FileChangesCard, FileDiffPanel } from "../../src/components/CLI/FileChanges";
import { useConversationStore } from "../../src/store/conversationStore";
import { useFileDiffStore } from "../../src/store/fileDiffStore";
import type { CliStreamItem } from "../../src/services/cli/parsers";

void i18next.changeLanguage("zh-CN");
useConversationStore.setState({ activeId: "markdown-preview" });
const before = `# 任务列表：检查与加固 API 参数校验

这份记录用于核对微信和 QQ 两端小程序的接口参数约束。需要逐项检查权限、分页、时间范围与异常返回，避免因为缺失校验影响用户已有的业务流程。

## 校验进度

- [x] 检查接口参数类型
- [ ] 补充分页范围约束
- [ ] 完成 PHP 语法检查

| 接口 | 状态 |
| --- | --- |
| Answer.php | 待检查 |
| Confirm.php | 已检查 |

## 验证命令

\`\`\`powershell
Get-ChildItem -Path "application/controllers/Api/Exam/*.php" | ForEach-Object { php -l $_.FullName }
\`\`\`
`;
const after = before.replace("- [ ] 补充分页范围约束", "- [x] 补充分页范围约束：限制在 1–100 页，并为缺失参数返回明确提示。")
  .replace("| Answer.php | 待检查 |", "| Answer.php | 已检查 |")
  .replace("## 验证命令", "> 参数校验规则与两个小程序现有传参方式保持兼容。\n\n## 验证命令");
const final = after.replace("- [ ] 完成 PHP 语法检查", "- [x] 完成 PHP 语法检查，全部 9 个 Controller 文件通过。")
  + "\n这是较长的一段验证说明，用于检查中文段落在窄面板中的自动换行。".repeat(9) + "\n";
const edits: Extract<CliStreamItem, { kind: "file-edit" }>[] = [
  { kind: "file-edit", path: "docs/task.md", action: "update", blobKey: "markdown-full", counts: { added: 5, removed: 2 } },
  { kind: "file-edit", path: "application/Answer.php", action: "update", oldText: "$page = $input;\n", newText: "$page = max(1, min(100, intval($input)));\n" },
  { kind: "file-edit", path: "docs/task.md", action: "update", oldText: after, newText: final },
  { kind: "file-edit", path: "docs/truncated.md", action: "create", blobKey: "truncated", counts: { added: 2, removed: 0 } },
  { kind: "file-edit", path: "docs/snippet.md", action: "update", oldText: "- [ ] 检查权限\n", newText: "- [x] 检查权限\n", partial: true },
  { kind: "file-edit", path: "docs/deleted.md", action: "delete", oldText: "# 已归档\n\n历史说明。\n" },
  { kind: "file-edit", path: "docs/empty.md", action: "create", newText: "" }
];
window.freebuddy = { cli: {
  async listMessageFileEdits() { return { edits, nextCursor: edits.length, hasMore: false }; },
  async readFileEditBlob(_conversationId: string, blobKey: string, offset = 0) {
    await new Promise(resolve => setTimeout(resolve, 150));
    const content = blobKey === "truncated"
      ? { newText: '"# 任务列表：检查与加固 API 参数校验\\n\\n结合微信与 QQ 两个小程序检查权限。\\n\n<truncated 1127 bytes>' }
      : { oldText: before, newText: after };
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    const page = bytes.slice(offset, offset + 65536);
    return { data: btoa(Array.from(page, byte => String.fromCharCode(byte)).join("")), nextOffset: offset + page.length, totalBytes: bytes.length, hasMore: offset + page.length < bytes.length };
  }
}, settings: { async setSetting() {} } } as unknown as typeof window.freebuddy;

function Preview() {
  const [narrow, setNarrow] = useState(false);
  const [dark, setDark] = useState(false);
  const selection = useFileDiffStore(state => state.selection);
  return <div className="markdown-diff-fixture" style={{ display: "flex", height: "100dvh", background: "var(--fb-home-bg-primary)", color: "var(--fb-text-primary)", overflow: "hidden" }}>
    <main style={{ flex: 1, minWidth: 0, padding: 24, overflow: "auto" }}>
      <h2>Markdown 文件变更</h2>
      <p>同一文件有两次修改，PHP 记录穿插其中。</p>
      <div style={{ display: "flex", gap: 12, margin: "18px 0", flexWrap: "wrap" }}>
        <button onClick={() => setNarrow(!narrow)}>切换面板宽度</button>
        <button onClick={() => { document.documentElement.dataset.theme = dark ? "light" : "dark"; setDark(!dark); }}>切换主题</button>
        <button onClick={() => void i18next.changeLanguage(i18next.language === "zh-CN" ? "en" : "zh-CN")}>切换语言</button>
      </div>
      <FileChangesCard items={edits} conversationId="markdown-preview" messageId="markdown-message" />
    </main>
    {selection && <aside style={{ display: "flex", flex: "0 1 auto", width: narrow ? 360 : 680, minWidth: 0, padding: 16, borderLeft: "1px solid var(--fb-border)" }}><FileDiffPanel /></aside>}
    <style>{`@media (max-width: 760px) { .markdown-diff-fixture:has(aside) > main { display: none; } .markdown-diff-fixture aside { width: 100% !important; flex: 1 !important; padding: 12px !important; } }`}</style>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
