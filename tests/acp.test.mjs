import test from "node:test";
import assert from "node:assert/strict";

import { buildCommand, cliAdapterDefinitions } from "../dist-electron/cli/adapters.js";
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

test("buildCommand applies OpenCode ACP model through config env", () => {
  const built = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    cwd: "/tmp/project",
    extraArgs: ["-m", "openai/gpt-4.1", "--print-logs"]
  });

  assert.deepEqual(built.args, ["acp", "--cwd", "/tmp/project", "--print-logs"]);
  assert.deepEqual(built.env, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "openai/gpt-4.1" })
  });

  const withEquals = buildCommand({
    adapter: "opencode-acp",
    prompt: "hello",
    extraArgs: ["--model=anthropic/claude-sonnet-4"]
  });
  assert.deepEqual(withEquals.args, ["acp"]);
  assert.deepEqual(withEquals.env, {
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "anthropic/claude-sonnet-4" })
  });
});

test("visible adapter definitions are ACP-only with product names", () => {
  assert.deepEqual(
    cliAdapterDefinitions.map((definition) => ({
      id: definition.id,
      label: definition.label,
      protocol: definition.protocol
    })),
    [
      { id: "codex-acp", label: "Codex", protocol: "acp" },
      { id: "claude-agent-acp", label: "ClaudeCode", protocol: "acp" },
      { id: "opencode-acp", label: "OpenCode", protocol: "acp" },
      { id: "cursor-agent-acp", label: "Cursor", protocol: "acp" }
    ]
  );
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

test("buildCommand translates Codex model shorthand for codex-acp", () => {
  assert.deepEqual(
    buildCommand({
      adapter: "codex-acp",
      prompt: "hello",
      extraArgs: ["-m", "gpt-5", "--config", "approval_policy=never"]
    }),
    {
      bin: "codex-acp",
      args: ["-c", 'model="gpt-5"', "--config", "approval_policy=never"],
      promptViaStdin: false,
      protocol: "acp"
    }
  );

  assert.deepEqual(
    buildCommand({
      adapter: "codex-acp",
      prompt: "hello",
      extraArgs: ["--model=o3"]
    }).args,
    ["-c", 'model="o3"']
  );
});

test("buildCommand applies ClaudeCode ACP model through environment", () => {
  const built = buildCommand({
    adapter: "claude-agent-acp",
    prompt: "hello",
    extraArgs: ["--model=claude-sonnet-4-5", "--hide-claude-auth"]
  });

  assert.deepEqual(built.args, ["--hide-claude-auth"]);
  assert.deepEqual(built.env, {
    ANTHROPIC_MODEL: "claude-sonnet-4-5"
  });
});

test("buildCommand starts Cursor through its ACP server", () => {
  const built = buildCommand({
    adapter: "cursor-agent-acp",
    prompt: "hello"
  });

  assert.equal(built.bin, "cursor-agent");
  assert.deepEqual(built.args, ["acp"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand applies Cursor ACP model through CURSOR_MODEL env", () => {
  const built = buildCommand({
    adapter: "cursor-agent-acp",
    prompt: "hello",
    extraArgs: ["-m", "gpt-5", "--print"]
  });

  assert.deepEqual(built.args, ["acp", "--print"]);
  assert.deepEqual(built.env, { CURSOR_MODEL: "gpt-5" });
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
      used: 53000,
      size: 200000,
      cost: { amount: 0.045, currency: "USD" }
    }),
    [
      {
        kind: "usage",
        contextUsed: 53000,
        contextSize: 200000,
        costAmount: 0.045,
        costCurrency: "USD"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({ sessionUpdate: "usage_update", used: 1200 }),
    [{ kind: "usage", contextUsed: 1200 }]
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
