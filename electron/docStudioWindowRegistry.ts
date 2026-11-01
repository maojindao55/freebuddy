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
  if (mainWindowWebContentsId === webContentsId) {
    mainWindowWebContentsId = null;
    // The main window's renderer is gone, so nothing can stay docked in it.
    clearDocStudioEmbeddedConversations();
  }
}

export function isDocStudioMainWindowSender(sender: { id: number }): boolean {
  return mainWindowWebContentsId !== null && sender.id === mainWindowWebContentsId;
}

// The doc-studio conversations currently docked into the main window's
// embedded viewer. Docking is a per-conversation record, not "the one
// conversation the viewer is showing": switching the main window to another
// conversation keeps the record so clicking back re-docks instead of popping
// a standalone window. Records are written when a conversation docks
// (openConversationInMain with embed) and removed only when it is explicitly
// popped out (docStudio:openConversation), deleted (deleteConversation) or
// the main window goes away. Read by open-conversation routing so a docked
// conversation stays in the embedded viewer instead of popping a standalone
// window.
const dockedDocStudioConversationIds = new Set<string>();

export function addDocStudioEmbeddedConversation(conversationId: string): void {
  if (conversationId) dockedDocStudioConversationIds.add(conversationId);
}

export function removeDocStudioEmbeddedConversation(conversationId: string): void {
  dockedDocStudioConversationIds.delete(conversationId);
}

export function clearDocStudioEmbeddedConversations(): void {
  dockedDocStudioConversationIds.clear();
}

export function listDocStudioEmbeddedConversations(): string[] {
  return [...dockedDocStudioConversationIds];
}

export function isDocStudioConversationEmbedded(conversationId: string): boolean {
  return dockedDocStudioConversationIds.has(conversationId);
}
