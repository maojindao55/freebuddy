type AppLocale = "en" | "zh-CN";

const DICT: Record<string, Record<AppLocale, string>> = {
  "menu.app.about": { en: "About", "zh-CN": "关于" },
  "menu.app.hide": { en: "Hide", "zh-CN": "隐藏" },
  "menu.app.hideOthers": { en: "Hide Others", "zh-CN": "隐藏其他" },
  "menu.app.unhide": { en: "Show All", "zh-CN": "显示全部" },
  "menu.app.quit": { en: "Quit", "zh-CN": "退出" },
  "menu.edit": { en: "Edit", "zh-CN": "编辑" },
  "menu.file": { en: "File", "zh-CN": "文件" },
  "menu.file.openDocument": { en: "Open Document (DocStudio)...", "zh-CN": "打开文档 (DocStudio)..." },
  "menu.file.newSpreadsheet": { en: "New Spreadsheet (DocStudio)", "zh-CN": "新建表格 (DocStudio)" },
  "menu.file.closeWindow": { en: "Close Window", "zh-CN": "关闭窗口" },
  "contextMenu.openInDocStudio": { en: 'Open "{{name}}" in DocStudio', "zh-CN": '在独立窗口打开 "{{name}}" (DocStudio)' },
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
