import path from "node:path";
import { fileURLToPath } from "node:url";
import { Menu, MenuItem, BrowserWindow } from "electron";
import { tMain } from "./cli/i18n.js";
import { getLanguage } from "./cli/settings.js";
import { APP_NAME } from "./app-meta.js";
import { isOfficeOrDocFile, openDocStudioWindow, showDocStudioOpenDialog } from "./docStudioBridge.js";

export function buildAppMenu(lang: "en" | "zh-CN") {
  return Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: "about", label: tMain("menu.app.about", lang) },
        { type: "separator" },
        { role: "hide", label: tMain("menu.app.hide", lang) },
        { role: "hideOthers", label: tMain("menu.app.hideOthers", lang) },
        { role: "unhide", label: tMain("menu.app.unhide", lang) },
        { type: "separator" },
        { role: "quit", label: `${tMain("menu.app.quit", lang)} ${APP_NAME}` }
      ]
    },
    {
      label: tMain("menu.file", lang),
      submenu: [
        {
          label: tMain("menu.file.openDocument", lang),
          accelerator: "CmdOrCtrl+O",
          click: async () => {
            const files = await showDocStudioOpenDialog();
            if (files && files[0]) {
              openDocStudioWindow(files[0]);
            }
          }
        },
        {
          label: tMain("menu.file.newSpreadsheet", lang),
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => {
            openDocStudioWindow();
          }
        },
        { type: "separator" },
        { role: "close", label: tMain("menu.file.closeWindow", lang) }
      ]
    },
    {
      label: tMain("menu.edit", lang),
      submenu: [
        { role: "undo", label: tMain("contextMenu.undo", lang) },
        { role: "redo", label: tMain("contextMenu.redo", lang) },
        { type: "separator" },
        { role: "cut", label: tMain("contextMenu.cut", lang) },
        { role: "copy", label: tMain("contextMenu.copy", lang) },
        { role: "paste", label: tMain("contextMenu.paste", lang) },
        { role: "selectAll", label: tMain("contextMenu.selectAll", lang) }
      ]
    }
  ]);
}

export function setApplicationMenuForLanguage(lang: "en" | "zh-CN") {
  // The application menu is a macOS convention (and macOS needs the Edit-menu
  // roles for Cmd+C/V/X/A/Z in text fields). On Windows/Linux the text-edit
  // shortcuts are handled natively by the OS, so we hide the in-window menu
  // bar there to keep the UI clean.
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(buildAppMenu(lang));
}

export function initApplicationMenu() {
  setApplicationMenuForLanguage(getLanguage());
}

export function setupContextMenu(window: BrowserWindow, isDev: boolean) {
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
      if ((selected.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(selected)) && isOfficeOrDocFile(selected)) {
        targetDocPath = selected;
      }
    }

    if (targetDocPath && isOfficeOrDocFile(targetDocPath)) {
      menu.append(new MenuItem({
        label: tMain("contextMenu.openInDocStudio", lang, { name: path.basename(targetDocPath) }),
        click: () => {
          if (targetDocPath) openDocStudioWindow(targetDocPath);
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
