import test from "node:test";
import assert from "node:assert/strict";

import { buildCommand } from "../dist-electron/cli/adapters.js";
import {
  acpUpdateToItems,
  buildInitializeRequest,
  buildSessionPromptRequest,
  parseAcpLine,
  shouldEmitAcpUpdate
} from "../dist-electron/cli/acp.js";

test("buildCommand starts OpenCode through its ACP server", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/project"
  });

  assert.equal(built.bin, "opencode");
  assert.deepEqual(built.args, ["acp", "--cwd", "/tmp/project"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand starts Codex and Claude ACP adapters", () => {
  assert.deepEqual(
    buildCommand({ adapter: "codex-acp", prompt: "hello" }),
    {
      bin: "codex-acp",
      args: [],
      promptViaStdin: false,
      protocol: "acp"
    }
  );
  assert.deepEqual(
    buildCommand({ adapter: "claude-agent-acp", prompt: "hello" }),
    {
      bin: "claude-agent-acp",
      args: [],
      promptViaStdin: false,
      protocol: "acp"
    }
  );
});

test("buildInitializeRequest advertises conservative client capabilities", () => {
  assert.deepEqual(buildInitializeRequest(7), {
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "freebuddy",
        title: "FreeBuddy",
        version: "0.1.0"
      }
    }
  });
});

test("buildSessionPromptRequest sends a text content block", () => {
  assert.deepEqual(buildSessionPromptRequest(8, "sess-1", "hello"), {
    jsonrpc: "2.0",
    id: 8,
    method: "session/prompt",
    params: {
      sessionId: "sess-1",
      prompt: [{ type: "text", text: "hello" }]
    }
  });
});

test("parseAcpLine parses JSON-RPC messages and ignores blank lines", () => {
  assert.equal(parseAcpLine(""), undefined);
  assert.deepEqual(parseAcpLine('{"jsonrpc":"2.0","id":1,"result":{}}'), {
    jsonrpc: "2.0",
    id: 1,
    result: {}
  });
});

test("acpUpdateToItems maps message, thought, tool, session and usage updates", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hi" }
    }),
    [{ kind: "text", role: "assistant", content: "Hi", append: true }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "Thinking" }
    }),
    [{ kind: "thinking", content: "Thinking", append: true }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run tests",
      kind: "execute",
      rawInput: { command: "npm test" }
    }),
    [{ kind: "tool-call", id: "tool-1", tool: "Run tests", input: { command: "npm test" } }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      title: "Run tests",
      rawOutput: "ok",
      status: "completed"
    }),
    [{ kind: "tool-result", id: "tool-1", tool: "Run tests", content: "ok" }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-2",
      title: "Web Search",
      rawOutput: "",
      status: "completed"
    }),
    [{ kind: "tool-result", id: "tool-2", tool: "Web Search", content: "" }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-3",
      title: "webfetch",
      rawOutput: { output: "Sofascore page content" },
      status: "completed"
    }),
    [
      {
        kind: "tool-result",
        id: "tool-3",
        tool: "webfetch",
        content: "Sofascore page content"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "session_info_update",
      sessionId: "sess-2",
      title: "Work"
    }),
    [{ kind: "session", sessionId: "sess-2", title: "Work" }]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "usage_update",
      usage: {
        inputTokens: 3,
        outputTokens: 4
      }
    }),
    [{ kind: "usage", inputTokens: 3, outputTokens: 4 }]
  );
});

test("acpUpdateToItems ignores ACP control updates that are not chat content", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "brainstorming", description: "Explore ideas" }]
    }),
    []
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "current_mode_update",
      currentModeId: "build"
    }),
    []
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "config_option_update",
      configOptions: []
    }),
    []
  );
});

test("acpUpdateToItems ignores ACP user message chunks because FreeBuddy renders user messages separately", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "user_message_chunk",
      messageId: "msg-user-1",
      content: { type: "text", text: "nihao" }
    }),
    []
  );
});

test("shouldEmitAcpUpdate suppresses replay updates before the current prompt starts", () => {
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "previous answer" }
      },
      { promptStarted: false }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "current answer" }
      },
      { promptStarted: true }
    ),
    true
  );
});
