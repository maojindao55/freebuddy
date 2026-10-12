import { Menu, type BrowserWindow } from "electron";
import { tMain } from "./cli/i18n.js";
import { getLanguage } from "./cli/settings.js";
import { APP_NAME } from "./app-meta.js";
import { openDocStudioWindow, showDocStudioOpenDialog } from "./docStudioBridge.js";
import { setupContextMenu as setupWindowContextMenu } from "./contextMenu.js";

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
  setupWindowContextMenu(window, isDev, openDocStudioWindow);
}
