import { Menu, MenuItem, BrowserWindow } from "electron";
import { tMain } from "./cli/i18n.js";
import { getLanguage } from "./cli/settings.js";
import { APP_NAME } from "./app-meta.js";

export function buildAppMenu(lang: "en" | "zh-CN") {
  return Menu.buildFromTemplate([
    {
      label: APP_NAME,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: tMain("menu.edit", lang),
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }
      ]
    },
    {
      label: tMain("menu.view", lang),
      submenu: [
        { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
        { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: tMain("menu.window", lang),
      submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "close" }]
    }
  ]);
}

export function setApplicationMenuForLanguage(lang: "en" | "zh-CN") {
  Menu.setApplicationMenu(buildAppMenu(lang));
}

export function initApplicationMenu() {
  const lang = getLanguage();
  Menu.setApplicationMenu(buildAppMenu(lang));
}

export function setupContextMenu(window: BrowserWindow, isDev: boolean) {
  window.webContents.on("context-menu", (_event, params) => {
    const lang = getLanguage();
    const menu = new Menu();
    const hasSelection = Boolean(params.selectionText && params.selectionText.trim());
    const isEditable = params.isEditable;

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
