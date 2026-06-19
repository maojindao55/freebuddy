import { app, BrowserWindow, nativeImage, net, protocol, shell } from "electron";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { shellEnv } from "shell-env";

import { registerCliIpc } from "./cli/ipc.js";
import { getDb } from "./cli/db.js";
import { initApplicationMenu } from "./menu.js";
import { tMain } from "./cli/i18n.js";
import { getLanguage } from "./cli/settings.js";
import { APP_NAME } from "./app-meta.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

app.setName(APP_NAME);
app.setAboutPanelOptions({ applicationName: APP_NAME });

function resolveAppIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "app-icon.png")
    : path.join(__dirname, "../assets/app-icon.png");
}

function loadAppIcon() {
  const icon = nativeImage.createFromPath(resolveAppIconPath());
  return icon.isEmpty() ? undefined : icon;
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: "freebuddy-file",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true
    }
  }
]);

function registerLocalFileProtocol() {
  protocol.handle("freebuddy-file", async (request) => {
    try {
      const url = new URL(request.url);
      const encoded = url.pathname + url.search;
      const decoded = decodeURIComponent(encoded.replace(/^\//, ""));
      const absolute = path.isAbsolute(decoded) ? decoded : `/${decoded}`;
      return await net.fetch(pathToFileURL(absolute).toString());
    } catch (error) {
      return new Response(
        tMain("main.fileLoadFailed", getLanguage(), {
          message: (error as Error).message
        }),
        { status: 404 }
      );
    }
  });
}

async function injectShellPath() {
  if (process.platform === "win32") return;
  try {
    const env = await shellEnv();
    for (const [k, v] of Object.entries(env)) {
      if (typeof v === "string" && !process.env[k]) {
        process.env[k] = v;
      }
    }
    if (env.PATH) process.env.PATH = env.PATH;
  } catch {
    /* best-effort */
  }
}

let mainWindow: BrowserWindow | null = null;

function createWindow() {
  const appIcon = loadAppIcon();

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: APP_NAME,
    ...(appIcon ? { icon: appIcon } : {}),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: "#0b1329",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  initApplicationMenu();

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  const sendChromeVisible = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send("window:chrome", !mainWindow.isFullScreen());
  };
  mainWindow.on("enter-full-screen", sendChromeVisible);
  mainWindow.on("leave-full-screen", sendChromeVisible);
  mainWindow.on("maximize", sendChromeVisible);
  mainWindow.on("unmaximize", sendChromeVisible);

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL as string);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(async () => {
  await injectShellPath();
  registerLocalFileProtocol();
  getDb();
  registerCliIpc();
  const appIcon = loadAppIcon();
  if (process.platform === "darwin" && app.dock && appIcon) {
    app.dock.setIcon(appIcon);
  }
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
