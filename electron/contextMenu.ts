import path from "node:path";
import { fileURLToPath } from "node:url";
import { Menu, MenuItem, type BrowserWindow } from "electron";
import { tMain } from "./cli/i18n.js";
import { getLanguage } from "./cli/settings.js";
import { isOfficeEngineFile } from "./officeEngineCore.js";

export function setupContextMenu(
  window: BrowserWindow,
  isDev: boolean,
  openDocument: (filePath: string) => void
) {
  window.webContents.on("context-menu", (_event, params) => {
    const lang = getLanguage();
    const menu = new Menu();
    const hasSelection = Boolean(params.selectionText && params.selectionText.trim());
    const isEditable = params.isEditable;

    // Detect if right clicked on a doc link or path
    let targetDocPath: string | null = null;
    const linkUrl = params.linkURL;
    if (linkUrl) {
      if (linkUrl.startsWith("freebuddy-file://")) {
        try {
          const parsed = new URL(linkUrl);
          targetDocPath = parsed.searchParams.get("path");
        } catch {}
      } else if (linkUrl.startsWith("file://")) {
        try {
          targetDocPath = fileURLToPath(linkUrl);
        } catch {}
      } else if (linkUrl.includes("/api/attachment?path=")) {
        try {
          const parsed = new URL(linkUrl, "http://127.0.0.1");
          targetDocPath = parsed.searchParams.get("path");
        } catch {}
      }
    }

    if (!targetDocPath && hasSelection) {
      const selected = params.selectionText.trim();
      if ((selected.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(selected)) && isOfficeEngineFile(selected)) {
        targetDocPath = selected;
      }
    }

    if (targetDocPath && isOfficeEngineFile(targetDocPath)) {
      menu.append(new MenuItem({
        label: tMain("contextMenu.openInDocStudio", lang, { name: path.basename(targetDocPath) }),
        click: () => {
          if (targetDocPath) openDocument(targetDocPath);
        }
      }));
      menu.append(new MenuItem({ type: "separator" }));
    }

    if (isEditable) {
      if (params.editFlags.canUndo) {
        menu.append(new MenuItem({ label: tMain("contextMenu.undo", lang), role: "undo" }));
      }
      if (params.editFlags.canRedo) {
        menu.append(new MenuItem({ label: tMain("contextMenu.redo", lang), role: "redo" }));
      }
      if (params.editFlags.canUndo || params.editFlags.canRedo) {
        menu.append(new MenuItem({ type: "separator" }));
      }
      if (params.editFlags.canCut) {
        menu.append(new MenuItem({ label: tMain("contextMenu.cut", lang), role: "cut" }));
      }
      if (params.editFlags.canCopy) {
        menu.append(new MenuItem({ label: tMain("contextMenu.copy", lang), role: "copy" }));
      }
      if (params.editFlags.canPaste) {
        menu.append(new MenuItem({ label: tMain("contextMenu.paste", lang), role: "paste" }));
      }
      if (params.editFlags.canSelectAll) {
        menu.append(new MenuItem({ type: "separator" }));
        menu.append(new MenuItem({ label: tMain("contextMenu.selectAll", lang), role: "selectAll" }));
      }
    } else if (hasSelection) {
      if (params.editFlags.canCopy) {
        menu.append(new MenuItem({ label: tMain("contextMenu.copy", lang), role: "copy" }));
      }
      if (params.editFlags.canSelectAll) {
        menu.append(new MenuItem({ label: tMain("contextMenu.selectAll", lang), role: "selectAll" }));
      }
    }

    if (isDev) {
      if (menu.items.length > 0) {
        menu.append(new MenuItem({ type: "separator" }));
      }
      menu.append(
        new MenuItem({
          label: tMain("contextMenu.inspectElement", lang),
          click: () => window.webContents.inspectElement(params.x, params.y)
        })
      );
    }

    if (menu.items.length > 0) {
      menu.popup();
    }
  });
}
