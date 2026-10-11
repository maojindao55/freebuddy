// Keep this module Electron-free: ACP runtime is also imported by plain Node
// tests, where Electron's BrowserWindow and screen exports are unavailable.
const docStudioWebContentsIds = new Set<number>();

export function registerDocStudioWindow(webContentsId: number): void {
  docStudioWebContentsIds.add(webContentsId);
}

export function unregisterDocStudioWindow(webContentsId: number): void {
  docStudioWebContentsIds.delete(webContentsId);
}

export function isDocStudioWindowSender(sender: { id: number }): boolean {
  return docStudioWebContentsIds.has(sender.id);
}
