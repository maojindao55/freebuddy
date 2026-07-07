import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { buildCommand, cliAdapterDefinitions } from "../dist-electron/cli/adapters.js";
import {
  acpSessionListToItems,
  acpSessionSetupToItems,
  acpUpdateToItems,
  buildInitializeRequest,
  buildPromptContentBlocks,
  buildSessionLoadRequest,
  buildSessionPromptRequest,
  contentBlockToItems,
  parseAcpLine,
  shouldEmitAcpUpdate,
  shouldSkipUserMessageChunk
} from "../dist-electron/cli/acp.js";

const acpRuntimeSource = fs.readFileSync(
  new URL("../electron/cli/acpRuntime.ts", import.meta.url),
  "utf8"
);

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
      { id: "cursor-agent-acp", label: "Cursor", protocol: "acp" },
      { id: "kimi-acp", label: "Kimi", protocol: "acp" },
      { id: "qoder-acp", label: "Qoder", protocol: "acp" }
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
      args: [],
      env: {
        CODEX_CONFIG: JSON.stringify({
          model: "gpt-5",
          approval_policy: "never"
        })
      },
      promptViaStdin: false,
      protocol: "acp"
    }
  );

  const withEquals = buildCommand({
    adapter: "codex-acp",
    prompt: "hello",
    extraArgs: ["--model=o3"]
  });
  assert.deepEqual(withEquals.args, []);
  assert.deepEqual(withEquals.env, {
    CODEX_CONFIG: JSON.stringify({ model: "o3" })
  });
});

test("buildCommand maps Codex ACP config args to CODEX_CONFIG for new codex-acp", () => {
  const built = buildCommand({
    adapter: "codex-acp",
    prompt: "hello",
    extraArgs: [
      "-c",
      "model_provider=proxy",
      "--config",
      'model_providers.proxy.base_url="https://proxy.example.com/v1"'
    ]
  });

  assert.deepEqual(built.args, []);
  assert.deepEqual(JSON.parse(built.env.CODEX_CONFIG), {
    model_provider: "proxy",
    model_providers: {
      proxy: {
        base_url: "https://proxy.example.com/v1"
      }
    }
  });
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

test("buildCommand starts Kimi through its ACP server", () => {
  const built = buildCommand({ adapter: "kimi-acp", prompt: "hello" });

  assert.equal(built.bin, "kimi");
  assert.deepEqual(built.args, ["acp"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand applies Kimi ACP model through KIMI_MODEL_NAME env", () => {
  const built = buildCommand({
    adapter: "kimi-acp",
    prompt: "hello",
    extraArgs: ["-m", "kimi-k2", "--yolo"]
  });

  assert.deepEqual(built.args, ["acp", "--yolo"]);
  assert.deepEqual(built.env, { KIMI_MODEL_NAME: "kimi-k2" });

  const withEquals = buildCommand({
    adapter: "kimi-acp",
    prompt: "hello",
    extraArgs: ["--model=moonshot-v1-128k"]
  });
  assert.deepEqual(withEquals.args, ["acp"]);
  assert.deepEqual(withEquals.env, { KIMI_MODEL_NAME: "moonshot-v1-128k" });
});

test("buildCommand starts Qoder through its ACP server", () => {
  const built = buildCommand({ adapter: "qoder-acp", prompt: "hello" });

  assert.equal(built.bin, "qodercli");
  assert.deepEqual(built.args, ["--acp"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildCommand forwards extra args to Qoder ACP server", () => {
  const built = buildCommand({
    adapter: "qoder-acp",
    prompt: "hello",
    extraArgs: ["--yolo", "--some-flag"]
  });

  assert.deepEqual(built.args, ["--acp", "--yolo", "--some-flag"]);
  assert.equal(built.promptViaStdin, false);
  assert.equal(built.protocol, "acp");
});

test("buildInitializeRequest advertises conservative client capabilities", () => {
  assert.deepEqual(buildInitializeRequest(7), {
    jsonrpc: "2.0",
    id: 7,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {
        auth: { terminal: true },
        terminal: true
      },
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

test("buildSessionLoadRequest loads Cursor-style ACP sessions", () => {
  assert.deepEqual(buildSessionLoadRequest(9, "sess-1", "/tmp/project"), {
    jsonrpc: "2.0",
    id: 9,
    method: "session/load",
    params: {
      sessionId: "sess-1",
      cwd: "/tmp/project",
      mcpServers: []
    }
  });
});

test("ACP runtime reports missing saved sessions separately from auth failures", () => {
  assert.match(acpRuntimeSource, /Saved agent session is no longer available/);
  assert.match(acpRuntimeSource, /function isLikelyAuthError|const isLikelyAuthError/);
  assert.match(
    acpRuntimeSource,
    /authMethods\.length > 0 && isLikelyAuthError\(sessionErr\)/
  );
  assert.match(
    acpRuntimeSource,
    /toolSessionId && isMissingSavedSessionError\(sessionErr\)/
  );
  assert.doesNotMatch(acpRuntimeSource, /authMethods\.length > 0\) throw authRequiredError/);
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
    [
      {
        kind: "tool-call",
        id: "tool-1",
        tool: "Run tests",
        input: { command: "npm test" },
        status: "pending",
        toolKind: "execute",
        toolOutputs: [{ kind: "command", command: "npm test" }]
      }
    ]
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
});

test("acpUpdateToItems maps session metadata, commands and config options", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "session_info_update",
      sessionId: "sess-2",
      title: "Work",
      updatedAt: "2026-06-23T12:00:00.000Z"
    }),
    [
      {
        kind: "session",
        sessionId: "sess-2",
        title: "Work",
        updatedAt: "2026-06-23T12:00:00.000Z"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "available_commands_update",
      availableCommands: [{ name: "brainstorming", description: "Explore ideas" }]
    }),
    [
      {
        kind: "available-commands",
        commands: [{ name: "brainstorming", description: "Explore ideas" }]
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-5",
          options: {
            values: [{ id: "gpt-5", name: "GPT-5" }]
          }
        }
      ]
    }),
    [
      {
        kind: "config-options",
        options: [
          {
            id: "model",
            name: "Model",
            type: "select",
            category: "model",
            currentValue: "gpt-5",
            currentLabel: "GPT-5",
            values: [{ id: "gpt-5", name: "GPT-5" }]
          }
        ]
      }
    ]
  );
});

test("buildPromptContentBlocks maps text and resource links for attachments", () => {
  assert.deepEqual(buildPromptContentBlocks("hello"), [{ type: "text", text: "hello" }]);
  const blocks = buildPromptContentBlocks("see file", [
    {
      path: "/tmp/readme.md",
      kind: "document",
      mimeType: "text/markdown",
      name: "readme.md"
    }
  ]);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0], { type: "text", text: "see file" });
  assert.equal(blocks[1].type, "resource_link");
  assert.match(String(blocks[1].uri), /readme\.md$/);
});

test("acpUpdateToItems ignores ACP control updates that are not chat content", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "current_mode_update",
      currentModeId: "build"
    }),
    []
  );
});

test("acpUpdateToItems maps OpenCode todo tool calls as plan updates", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call",
      toolCallId: "call_todos",
      title: "7 todos",
      kind: "other",
      status: "pending",
      rawInput: {
        todos: [
          {
            content: "Explore project context",
            status: "completed",
            priority: "high"
          },
          {
            content: "Ask clarifying questions",
            status: "in_progress",
            priority: "high"
          },
          {
            content: "Write implementation plan",
            status: "pending",
            priority: "medium"
          }
        ]
      }
    }),
    [
      {
        kind: "plan",
        entries: [
          {
            content: "Explore project context",
            status: "completed",
            priority: "high"
          },
          {
            content: "Ask clarifying questions",
            status: "in_progress",
            priority: "high"
          },
          {
            content: "Write implementation plan",
            status: "pending",
            priority: "medium"
          }
        ]
      }
    ]
  );
});

test("acpUpdateToItems maps OpenCode todo metadata updates as plan updates", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_todowrite",
      title: "todowrite",
      kind: "other",
      status: "completed",
      rawOutput: {
        metadata: {
          todos: [
            {
              content: "Handoff execution",
              status: "in_progress",
              priority: "medium"
            }
          ]
        }
      }
    }),
    [
      {
        kind: "plan",
        entries: [
          {
            content: "Handoff execution",
            status: "in_progress",
            priority: "medium"
          }
        ]
      }
    ]
  );
});

test("acpUpdateToItems ignores mode updates that are not chat content", () => {
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

test("contentBlockToItems maps ACP ContentBlock variants", () => {
  assert.deepEqual(
    contentBlockToItems({ type: "text", text: "Hello" }, { role: "assistant", append: true }),
    [{ kind: "text", role: "assistant", content: "Hello", append: true }]
  );
  assert.deepEqual(
    contentBlockToItems({ type: "text", text: "Plan" }, { asThinking: true, append: true }),
    [{ kind: "thinking", content: "Plan", append: true }]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "image",
      mimeType: "image/png",
      data: "aGVsbG8="
    }),
    [
      {
        kind: "content-block",
        blockType: "image",
        mimeType: "image/png",
        data: "aGVsbG8="
      }
    ]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "audio",
      mimeType: "audio/wav",
      data: "YXVkaW8="
    }),
    [
      {
        kind: "content-block",
        blockType: "audio",
        mimeType: "audio/wav",
        data: "YXVkaW8="
      }
    ]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "resource_link",
      uri: "file:///tmp/readme.md",
      name: "readme.md",
      title: "README",
      mimeType: "text/markdown",
      size: 2048
    }),
    [
      {
        kind: "content-block",
        blockType: "resource_link",
        uri: "file:///tmp/readme.md",
        name: "readme.md",
        title: "README",
        mimeType: "text/markdown",
        size: 2048
      }
    ]
  );
  assert.deepEqual(
    contentBlockToItems({
      type: "resource",
      resource: {
        uri: "file:///tmp/context.txt",
        mimeType: "text/plain",
        text: "embedded context"
      }
    }),
    [
      {
        kind: "content-block",
        blockType: "resource",
        uri: "file:///tmp/context.txt",
        mimeType: "text/plain",
        text: "embedded context"
      }
    ]
  );
});

test("acpUpdateToItems maps image and resource_link message chunks", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "image",
        mimeType: "image/jpeg",
        data: "Zm9v"
      }
    }),
    [
      {
        kind: "content-block",
        blockType: "image",
        mimeType: "image/jpeg",
        data: "Zm9v"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "resource_link",
        uri: "/workspace/README.md",
        name: "README.md"
      }
    }),
    [
      {
        kind: "content-block",
        blockType: "resource_link",
        uri: "/workspace/README.md",
        name: "README.md"
      }
    ]
  );
});

test("acpUpdateToItems maps tool_call_update content blocks", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-4",
      title: "Read file",
      content: [
        {
          type: "content",
          content: {
            type: "resource",
            resource: {
              mimeType: "text/plain",
              text: "file body"
            }
          }
        }
      ]
    }),
    [
      {
        kind: "tool-call",
        id: "tool-4",
        tool: "Read file",
        toolOutputs: [
          {
            kind: "content-block",
            blockType: "resource",
            mimeType: "text/plain",
            text: "file body"
          }
        ],
        replaceToolOutputs: true
      }
    ]
  );
});

test("acpUpdateToItems maps structured tool_call_update diff and terminal content", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-5",
      title: "Edit file",
      kind: "edit",
      status: "running",
      locations: [{ path: "/tmp/app.ts", line: 12 }],
      content: [
        {
          type: "diff",
          path: "/tmp/app.ts",
          oldText: "const a = 1;",
          newText: "const a = 2;"
        },
        {
          type: "terminal",
          terminalId: "term-1"
        }
      ]
    }),
    [
      {
        kind: "tool-call",
        id: "tool-5",
        tool: "Edit file",
        status: "running",
        toolKind: "edit",
        locations: [{ path: "/tmp/app.ts", line: 12 }],
        toolOutputs: [
          {
            kind: "file-edit",
            path: "/tmp/app.ts",
            action: "update",
            oldText: "const a = 1;",
            newText: "const a = 2;"
          },
          { kind: "terminal-embed", terminalId: "term-1" }
        ],
        replaceToolOutputs: true
      }
    ]
  );
});

test("acpUpdateToItems keeps legacy tool_call_update without toolCallId", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "tool_call_update",
      title: "Run tests",
      rawOutput: "ok",
      status: "completed"
    }),
    [{ kind: "tool-result", tool: "Run tests", content: "ok" }]
  );
});

test("acpUpdateToItems carries messageId for agent chunks", () => {
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-a-1",
      content: { type: "text", text: "Hi" }
    }),
    [
      {
        kind: "text",
        role: "assistant",
        content: "Hi",
        append: true,
        messageId: "msg-a-1"
      }
    ]
  );
  assert.deepEqual(
    acpUpdateToItems({
      sessionUpdate: "agent_thought_chunk",
      messageId: "msg-t-1",
      content: { type: "text", text: "Thinking" }
    }),
    [
      {
        kind: "thinking",
        content: "Thinking",
        append: true,
        messageId: "msg-t-1"
      }
    ]
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

test("shouldEmitAcpUpdate always emits session metadata updates", () => {
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "session_info_update",
        title: "Renamed session"
      },
      { promptStarted: false }
    ),
    true
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "config_option_update",
        configOptions: [{ id: "model", name: "Model", type: "select" }]
      },
      { promptStarted: false }
    ),
    true
  );
});

test("shouldEmitAcpUpdate suppresses persisted messageId replay after prompt starts", () => {
  const replayMessageIds = new Set(["msg-old-1"]);
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-old-1",
        content: { type: "text", text: "previous answer" }
      },
      { promptStarted: true, replayMessageIds }
    ),
    false
  );
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "msg-new-1",
        content: { type: "text", text: "fresh answer" }
      },
      { promptStarted: true, replayMessageIds }
    ),
    true
  );
});

test("shouldSkipUserMessageChunk deduplicates echoed user messages", () => {
  assert.equal(
    shouldSkipUserMessageChunk(
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-1",
        content: { type: "text", text: "hello" }
      },
      { userMessageId: "user-1", promptText: "hello" }
    ),
    true
  );
  assert.equal(
    shouldSkipUserMessageChunk(
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-2",
        content: { type: "text", text: "hello" }
      },
      { userMessageId: "user-1", promptText: "hello" }
    ),
    true
  );
  assert.equal(
    shouldSkipUserMessageChunk(
      {
        sessionUpdate: "user_message_chunk",
        messageId: "user-2",
        content: { type: "text", text: "different" }
      },
      { userMessageId: "user-1", promptText: "hello" }
    ),
    false
  );
});

test("acpSessionSetupToItems maps OpenCode session/new configOptions", () => {
  const items = acpSessionSetupToItems("sess-opencode", {
    sessionId: "sess-opencode",
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "anthropic/claude-sonnet-4",
        options: [
          {
            value: "anthropic/claude-sonnet-4",
            name: "Anthropic/Claude Sonnet 4"
          }
        ]
      },
      {
        id: "mode",
        name: "Session Mode",
        category: "mode",
        type: "select",
        currentValue: "build",
        options: [{ value: "build", name: "Build" }]
      }
    ]
  });

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    kind: "session",
    sessionId: "sess-opencode"
  });
  assert.equal(items[1].kind, "config-options");
  assert.equal(items[1].options.length, 2);
  assert.equal(items[1].options[0].currentLabel, "Anthropic/Claude Sonnet 4");
});

test("acpSessionSetupToItems maps Kimi legacy modes and models", () => {
  const items = acpSessionSetupToItems("sess-kimi", {
    session_id: "sess-kimi",
    modes: {
      current_mode_id: "default",
      available_modes: [
        { id: "default", name: "Default", description: "The default mode." }
      ]
    },
    models: {
      current_model_id: "kimi-k2",
      available_models: [
        { model_id: "kimi-k2", name: "kimi-k2" },
        { model_id: "kimi-k2,thinking", name: "kimi-k2 (thinking)" }
      ]
    }
  });

  assert.equal(items[1].kind, "config-options");
  assert.deepEqual(
    items[1].options.map((option) => option.id),
    ["mode", "model"]
  );
  assert.equal(items[1].options[1].currentValue, "kimi-k2");
});

test("acpSessionListToItems maps session/list titles", () => {
  const items = acpSessionListToItems("sess-1", {
    sessions: [
      {
        sessionId: "sess-1",
        cwd: "/tmp/project",
        title: "Implement auth flow",
        updatedAt: "2026-06-23T12:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(items, [
    {
      kind: "session",
      sessionId: "sess-1",
      title: "Implement auth flow",
      updatedAt: "2026-06-23T12:00:00.000Z"
    }
  ]);
});
