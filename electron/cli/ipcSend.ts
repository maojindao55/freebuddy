import type { WebContents } from "electron";

export function safeSendToWebContents(
  webContents: WebContents | null | undefined,
  channel: string,
  payload: unknown
): boolean {
  if (!webContents || webContents.isDestroyed()) return false;
  try {
    const frame = webContents.mainFrame;
    if (frame.isDestroyed()) return false;
    frame.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}
