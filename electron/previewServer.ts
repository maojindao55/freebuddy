import http from "node:http";
import type { WebContents } from "electron";

import { safeSendToWebContents } from "./cli/ipcSend.js";
import {
  DEFAULT_BRIDGE_PORT,
  setActiveBridgePort,
  isKnownBridgeAction,
  parseBridgeRequest
} from "./agentBridge.js";

let previewServer: http.Server | null = null;

export function startPreviewServer(
  getWebContents: () => WebContents | null
): void {
  if (previewServer) return;

  let currentPort = DEFAULT_BRIDGE_PORT;
  const maxPort = DEFAULT_BRIDGE_PORT + 100;

  function tryListen(port: number): void {
    if (port > maxPort) {
      console.error("[FreeBuddy] Preview Server: Could not bind to any port in range.");
      return;
    }

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

    server.on("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        server.close();
        tryListen(port + 1);
      } else {
        console.error(`[FreeBuddy] Preview Server error on port ${port}:`, err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      previewServer = server;
      setActiveBridgePort(port);
      console.log(`[FreeBuddy] Preview Server listening on 127.0.0.1:${port}`);
    });
  }

  tryListen(currentPort);
}
