import { Menu } from "electron";
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
  setApplicationMenuForLanguage(getLanguage());
}
