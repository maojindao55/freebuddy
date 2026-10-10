import * as readline from "node:readline";

/**
 * stdio → streamable-HTTP MCP relay for the office engine.
 *
 * The locally installed WorkBuddy Tencent Docs engine (`editor_sdk.exe`, see
 * electron/officeEngineCore.ts) exposes a streamable-HTTP MCP endpoint at
 * http://127.0.0.1:<port>/mcp with ~200 document tools (open_file, doc_*,
 * sheet_*, slide_*, save_file, ...). ACP agents only speak stdio MCP, so this
 * bridge relays newline-delimited JSON-RPC between the agent's stdio and the
 * engine's HTTP endpoint. Must stay Electron-free: it is spawned with
 * ELECTRON_RUN_AS_NODE.
 */

const mcpUrl = process.env.FREEBUDDY_OFFICE_MCP_URL || "";
if (!mcpUrl) {
  process.exit(1);
}

interface JsonRpcMessage {
  [key: string]: unknown;
  id?: unknown;
  method?: string;
  result?: { sessionId?: string } | Record<string, unknown>;
}

let sessionId: string | null = null;

function rememberSessionFrom(messages: JsonRpcMessage[]): void {
  for (const message of messages) {
    const id = (message.result as { sessionId?: string } | undefined)?.sessionId;
    if (typeof id === "string" && id) {
      sessionId = id;
      return;
    }
  }
}

async function post(message: JsonRpcMessage): Promise<JsonRpcMessage[]> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream"
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const response = await fetch(mcpUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(message)
  });
  const headerSession = response.headers.get("mcp-session-id");
  if (headerSession) sessionId = headerSession;

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("text/event-stream")) {
    const out: JsonRpcMessage[] = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        out.push(JSON.parse(payload) as JsonRpcMessage);
      } catch {
        /* skip malformed SSE events */
      }
    }
    if (!headerSession) rememberSessionFrom(out);
    return out;
  }

  if (!text.trim()) return [];
  try {
    const parsed = JSON.parse(text) as JsonRpcMessage;
    if (!headerSession) rememberSessionFrom([parsed]);
    return [parsed];
  } catch {
    return [];
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return;
  }
  void post(message)
    .then((responses) => {
      for (const response of responses) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    })
    .catch(() => {
      /* engine hiccup: drop the message; the agent will time out and retry */
    });
});
rl.on("close", () => {
  process.exit(0);
});
