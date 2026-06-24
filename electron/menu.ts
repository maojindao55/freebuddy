import { BrowserWindow, Menu } from "electron";
import { tMain } from "./cli/i18n.js";
import { getLanguage } from "./cli/settings.js";
import { APP_NAME } from "./app-meta.js";

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function sendDevAction(action: "injectTerminalDemo") {
  const win = BrowserWindow.getFocusedWindow();
  win?.webContents.send("dev:action", { action });
}

export function buildAppMenu(lang: "en" | "zh-CN") {
  const template: Electron.MenuItemConstructorOptions[] = [
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
  ];

  if (isDev) {
    template.push({
      label: tMain("menu.development", lang),
      submenu: [
        {
          label: tMain("menu.dev.injectTerminal", lang),
          accelerator: "CommandOrControl+Shift+T",
          click: () => sendDevAction("injectTerminalDemo")
        }
      ]
    });
  }

  return Menu.buildFromTemplate(template);
}

export function setApplicationMenuForLanguage(lang: "en" | "zh-CN") {
  if (isDev) {
    Menu.setApplicationMenu(buildAppMenu(lang));
    return;
  }
  Menu.setApplicationMenu(null);
}

export function initApplicationMenu() {
  setApplicationMenuForLanguage(getLanguage());
}
