type AppLocale = "en" | "zh-CN";

const DICT: Record<string, Record<AppLocale, string>> = {
  "menu.edit": { en: "Edit", "zh-CN": "编辑" },
  "menu.view": { en: "View", "zh-CN": "视图" },
  "menu.window": { en: "Window", "zh-CN": "窗口" },
  "dialog.supportedAttachments": { en: "Supported attachments", "zh-CN": "支持的附件" },
  "dialog.allFiles": { en: "All files", "zh-CN": "所有文件" },
  "main.fileLoadFailed": { en: "Failed to load file: {{message}}", "zh-CN": "加载文件失败：{{message}}" },
  "contextMenu.undo": { en: "Undo", "zh-CN": "撤销" },
  "contextMenu.redo": { en: "Redo", "zh-CN": "重做" },
  "contextMenu.cut": { en: "Cut", "zh-CN": "剪切" },
  "contextMenu.copy": { en: "Copy", "zh-CN": "复制" },
  "contextMenu.paste": { en: "Paste", "zh-CN": "粘贴" },
  "contextMenu.selectAll": { en: "Select All", "zh-CN": "全选" },
  "contextMenu.inspectElement": { en: "Inspect Element", "zh-CN": "检查元素" }
};

export function tMain(key: string, lang: AppLocale, vars?: Record<string, string>): string {
  const entry = DICT[key]?.[lang] ?? DICT[key]?.en ?? key;
  if (!vars) return entry;
  return entry.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}
