// Keep this module Electron-free: ACP runtime is also imported by plain Node
// tests, where Electron's BrowserWindow and screen exports are unavailable.
const docStudioWebContentsIds = new Set<number>();

// The main window's own webContents is allow-listed separately: the embedded
// doc viewer runs there, while sibling WebContentsViews (built-in browser,
// third-party pages) must never pass the guard.
let mainWindowWebContentsId: number | null = null;

export function registerDocStudioWindow(webContentsId: number): void {
  docStudioWebContentsIds.add(webContentsId);
}

export function unregisterDocStudioWindow(webContentsId: number): void {
  docStudioWebContentsIds.delete(webContentsId);
}

export function isDocStudioWindowSender(sender: { id: number }): boolean {
  return docStudioWebContentsIds.has(sender.id);
}

export function registerDocStudioMainWindow(webContentsId: number): void {
  mainWindowWebContentsId = webContentsId;
}

export function unregisterDocStudioMainWindow(webContentsId: number): void {
  if (mainWindowWebContentsId === webContentsId) mainWindowWebContentsId = null;
}

export function isDocStudioMainWindowSender(sender: { id: number }): boolean {
  return mainWindowWebContentsId !== null && sender.id === mainWindowWebContentsId;
}
