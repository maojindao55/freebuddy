import http from "node:http";
import type { WebContents } from "electron";

import { safeSendToWebContents } from "./cli/ipcSend.js";
import { BRIDGE_PORT, isKnownBridgeAction, parseBridgeRequest } from "./agentBridge.js";

let previewServer: http.Server | null = null;

export function startPreviewServer(
  getWebContents: () => WebContents | null
): void {
  if (previewServer) return;
  const server = http.createServer((req, res) => {
    const parsed = parseBridgeRequest(req.url || "");
    if (parsed && isKnownBridgeAction(parsed.action)) {
      safeSendToWebContents(getWebContents(), "freebuddy://bridge", parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, action: parsed.action }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("error", () => {
    // listen failed (port in use) — bridge unavailable; actions fall back to manual UI
  });
  server.listen(BRIDGE_PORT, "127.0.0.1", () => {
    previewServer = server;
  });
}
