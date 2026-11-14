import readline from "node:readline";
import fs from "node:fs";

const audit = process.argv[2];
const reply = (request, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  if (request.method === "initialize") reply(request, {
    protocolVersion: request.params.protocolVersion,
    capabilities: { tools: {} }, serverInfo: { name: "freebuddy-eval", version: "1.0.0" }
  });
  else if (request.method === "tools/list") reply(request, { tools: [{
    name: "freebuddy_test_echo", description: "Echo a value to verify the FreeBuddy MCP connection.",
    inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }
  }] });
  else if (request.method === "tools/call") {
    fs.appendFileSync(audit, JSON.stringify(request.params) + "\n");
    reply(request, { content: [{ type: "text", text: `ECHO:${request.params.arguments.value}` }] });
  } else reply(request, {});
});
