import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

import {
  selectAcpSessionStartMode,
  shouldEmitAcpUpdate
} from "../dist-electron/cli/acp.js";

function toDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function loadConversationStoreHarness() {
  const mockSource = `
    let nextId = 0;
    let savedToolSession = {
      adapter: "mock-acp",
      sessionId: "saved-session"
    };

    export let capturedRunArgs;
    export let followupMessages = [];
    export let capturedFollowupQuery;
    export let capturedForkInput;
    export function setFollowupMessages(value) { followupMessages = value; }

    export function setSavedToolSession(value) {
      savedToolSession = value;
    }

    export function create(initializer) {
      let state;
      const getState = () => state;
      const setState = (update, replace = false) => {
        const next = typeof update === "function" ? update(state) : update;
        state = replace ? next : { ...state, ...next };
      };
      state = initializer(setState, getState);
      const store = (selector = (value) => value) => selector(state);
      store.getState = getState;
      store.setState = setState;
      store.subscribe = () => () => {};
      return store;
    }

    export function nanoid() {
      nextId += 1;
      return \`generated-\${nextId}\`;
    }

    export const builtinCliMembers = [
      {
        id: "agent-1",
        kind: "cli",
        name: "Mock ACP",
        enabled: true,
        cli: {
          adapter: "mock-acp",
          approvalMode: "auto",
          showStderr: false
        }
      }
    ];

    export const cliClient = {
      appendMessage: async (message) => message,
      archiveConversation: async () => undefined,
      forkConversation: async (input) => {
        capturedForkInput = input;
        return {
          conversation: {
            id: input.targetConversationId,
            title: input.title ?? "Forked",
            agentId: "agent-1",
            agentName: "Mock ACP",
            adapter: "mock-acp",
            skillSnapshot: [],
            createdAt: "2026-10-28T00:00:00.000Z",
            updatedAt: "2026-10-28T00:00:00.000Z"
          },
          copiedMessages: 2
        };
      },
      getToolSession: async () => savedToolSession,
      isAvailable: () => true,
      listMessages: async () => ({ messages: [], hasMore: false }),
      listFollowupMessages: async (conversationId, excludeMessageIds) => {
        capturedFollowupQuery = { conversationId, excludeMessageIds };
        return followupMessages.filter((message) => !excludeMessageIds.includes(message.id));
      },
      updateMessage: async () => undefined,
      onEvent: () => () => {},
      awaitPendingMcpSelection: async () => {},
      run: async (args) => {
        capturedRunArgs = args;
      }
    };

    export function getParser() {
      return () => [];
    }

    export const workflowFollowupAgentId = () => undefined;
    export const workflowClient = {
      isAvailable: () => false,
      listRuns: async () => [],
      getSteps: async () => []
    };

    export const composeMessageWithAttachments = (prompt) => prompt;
    export const filterSessionConfigPickerOptions = () => [];
    export const resolveConfigOptionOverrides = () => undefined;

    export const useCliExecutorStore = {
      getState: () => ({
        adapters: [],
        runtimes: {},
        resolve: () => ({
          enabled: true,
          binary: "mock-agent",
          extraArgs: [],
          env: {},
          protocol: "acp",
          streamMode: "raw"
        }),
        listResolved: () => []
      })
    };

    export const useProjectStore = {
      getState: () => ({ projects: [] })
    };

    export const buildOrphanFollowupContext = () => undefined;
    export const composeOrphanFollowupPrompt = (prompt) => prompt;
    export const defaultTitleFor = () => "Mock ACP";
    export const feedArticleTitleFromMessages = () => undefined;
    export const mergeConversationMessages = (_, messages) => messages;
    export const shouldApplyAgentSessionTitle = () => false;
    export const handleStreamControlEvent = () => false;
    export const handleStreamEvent = () => undefined;
    export const killConversation = async () => undefined;
    export const latestConfigOptionsFromItems = () => [];
    export const latestConfigOptionsFromMessages = () => [];
    export const latestSessionInfoFromMessages = () => undefined;
    export const loadUnreadConversations = () => ({});
    export const persistUnreadConversations = () => undefined;
    export const isAppInBackground = () => false;
    export const debugLogClient = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    };
  `;
  const mockUrl = toDataUrl(mockSource);
  const readingUrl = toDataUrl(
    ts.transpileModule(
      fs.readFileSync(new URL("../src/store/conversationReading.ts", import.meta.url), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }
    ).outputText
  );
  const conversationUtilsSource = fs.readFileSync(
    new URL("../src/store/conversationUtils.ts", import.meta.url),
    "utf8"
  );
  const conversationUtilsUrl = toDataUrl(
    ts.transpileModule(conversationUtilsSource, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
      }
    }).outputText.replace(
      '"@freebuddy/cli-stream"', JSON.stringify(import.meta.resolve("@freebuddy/cli-stream"))
    )
  );
  const skillCommandsUrl = toDataUrl(ts.transpileModule(
    fs.readFileSync(new URL("../src/utils/skillCommands.ts", import.meta.url), "utf8"),
    { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }
  ).outputText);
  const source = fs.readFileSync(
    new URL("../src/store/conversationStore.ts", import.meta.url),
    "utf8"
  );
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const mockedStoreSource = transpiled.replace(
    /from\s+["']([^"']+)["']/g,
    (_, specifier) =>
      `from "${
        specifier === "@/utils/skillCommands" ? skillCommandsUrl : specifier === "./conversationUtils"
          ? conversationUtilsUrl
          : specifier === "./conversationReading"
            ? readingUrl
          : mockUrl
      }"`
  );

  const [storeModule, mocks] = await Promise.all([
    import(toDataUrl(mockedStoreSource)),
    import(mockUrl)
  ]);
  return { ...storeModule, mocks };
}

test("sendMessage keeps matching live chunks when a saved ACP session falls back to session/new", async () => {
  const { useConversationStore, mocks } =
    await loadConversationStoreHarness();
  const timestamp = "2026-07-29T10:00:00.000Z";
  const previousAnswer = "same as a previous answer";
  const conversation = {
    id: "conv-1",
    title: "Replay test",
    agentId: "agent-1",
    agentName: "Mock ACP",
    adapter: "mock-acp",
    cwd: "C:\\work\\sample",
    approvalMode: "auto",
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const previousMessage = {
    id: "assistant-old",
    conversationId: conversation.id,
    role: "assistant",
    status: "done",
    content: JSON.stringify([
      { kind: "session", sessionId: "saved-session" },
      { kind: "text", role: "assistant", content: previousAnswer }
    ]),
    createdAt: timestamp,
    updatedAt: timestamp
  };

  useConversationStore.setState({
    conversations: [conversation],
    messages: { [conversation.id]: [previousMessage] },
    live: {},
    pendingFreshContext: {}
  });

  await useConversationStore.getState().sendMessage({
    conversationId: conversation.id,
    prompt: "continue",
    userMessageId: "user-current",
    assistantMessageId: "assistant-current"
  });

  const runArgs = mocks.capturedRunArgs;
  assert.equal(runArgs.toolSessionId, "saved-session");
  assert.deepEqual(runArgs.knownStreamContentSignatures, [previousAnswer]);

  const sessionStartMode = selectAcpSessionStartMode(runArgs.toolSessionId, {
    sessionCapabilities: {}
  });
  assert.equal(sessionStartMode, "new");
  assert.equal(
    shouldEmitAcpUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: previousAnswer }
      },
      {
        promptStarted: true,
        replaySuppressionEnabled: sessionStartMode !== "new",
        replayContentSignatures: new Set(
          runArgs.knownStreamContentSignatures
        )
      }
    ),
    true
  );

  mocks.setSavedToolSession(undefined);
  const freshConversation = {
    ...conversation,
    id: "conv-2",
    title: "Fresh test"
  };
  useConversationStore.setState({
    conversations: [freshConversation],
    messages: {
      [freshConversation.id]: [
        {
          ...previousMessage,
          id: "assistant-fresh-old",
          conversationId: freshConversation.id,
          content: JSON.stringify([
            { kind: "text", role: "assistant", content: previousAnswer }
          ])
        }
      ]
    },
    live: {},
    pendingFreshContext: {}
  });

  await useConversationStore.getState().sendMessage({
    conversationId: freshConversation.id,
    prompt: "fresh prompt",
    userMessageId: "user-fresh",
    assistantMessageId: "assistant-fresh"
  });

  assert.equal(
    Object.hasOwn(
      mocks.capturedRunArgs,
      "knownStreamContentSignatures"
    ),
    false
  );
});

test("orphan followup uses database history regardless of the UI history window", async () => {
  const prompts = [];
  for (const showOldHistory of [false, true]) {
    const { useConversationStore, mocks } = await loadConversationStoreHarness();
    mocks.setSavedToolSession(undefined);
    const timestamp = "2026-09-15T00:00:00Z";
    const conversation = {
      id: "context-conversation", title: "Context", agentId: "agent-1",
      agentName: "Mock ACP", adapter: "mock-acp", cwd: "/tmp/context",
      createdAt: timestamp, updatedAt: timestamp
    };
    const make = (id, role, status, content) => ({
      id, conversationId: conversation.id, role, status, content,
      createdAt: timestamp, updatedAt: timestamp
    });
    const history = [
      make("original-ask", "user", "sent", "Implement the missing remote feature"),
      make("failed-answer", "assistant", "failed", "[]")
    ];
    mocks.setFollowupMessages(history);
    const systemMessages = Array.from({ length: 40 }, (_, index) =>
      make(`notice-${index}`, "system", "done", "Team activity")
    );
    useConversationStore.setState({
      conversations: [conversation],
      messages: { [conversation.id]: showOldHistory ? [...history, ...systemMessages] : systemMessages },
      live: {}, pendingFreshContext: {}
    });
    await useConversationStore.getState().sendMessage({
      conversationId: conversation.id, prompt: "continue",
      userMessageId: "current-user", assistantMessageId: "current-assistant"
    });
    assert.deepEqual(mocks.capturedFollowupQuery, {
      conversationId: conversation.id,
      excludeMessageIds: ["current-user", "current-assistant"]
    });
    assert.match(mocks.capturedRunArgs.prompt, /Implement the missing remote feature/);
    prompts.push(mocks.capturedRunArgs.prompt);
  }
  assert.equal(prompts[0], prompts[1]);
});


test("selected skills are invoked and saved for one message without changing conversation defaults", async () => {
  const { useConversationStore, mocks } = await loadConversationStoreHarness();
  const base = { id: "base", name: "base", description: "Base", rootPath: "/skills/base", contentHash: "base", version: "1", source: "builtin" };
  const selected = { ...base, id: "review", name: "代码审查", rootPath: "/skills/review" };
  useConversationStore.setState({
    members: mocks.builtinCliMembers,
    conversations: [{ id: "skill-conv", agentId: "agent-1", adapter: "mock-acp", title: "Skill test", skillSnapshot: [base] }],
    messages: {}, live: {}, pendingFreshContext: {}
  });
  await useConversationStore.getState().sendMessage({ conversationId: "skill-conv", prompt: "检查本次改动", messageSkills: [selected] });
  assert.deepEqual(mocks.capturedRunArgs.skills.map(s => s.id), ["base", "review"]);
  assert.equal(mocks.capturedRunArgs.announceSkills, true);
  assert.match(mocks.capturedRunArgs.prompt, /代码审查/);
  const user = useConversationStore.getState().messages["skill-conv"].find(m => m.role === "user");
  assert.deepEqual(user.skillSnapshot, [selected]);
  assert.equal(user.content, "检查本次改动");
  assert.deepEqual(useConversationStore.getState().conversations[0].skillSnapshot, [base]);
  useConversationStore.setState({ live: {} });
  await useConversationStore.getState().sendMessage({ conversationId: "skill-conv", prompt: "下一条普通消息" });
  assert.deepEqual(mocks.capturedRunArgs.skills, [base]);
  assert.doesNotMatch(mocks.capturedRunArgs.prompt, /skills selected for this message/);
});

test("archiveConversation hides the row and restore re-inserts it at the top", async () => {
  const { useConversationStore } = await loadConversationStoreHarness();
  const timestamp = "2026-07-29T10:00:00.000Z";
  const conversation = {
    id: "conv-archive",
    title: "Archive me",
    agentId: "agent-1",
    agentName: "Mock ACP",
    adapter: "mock-acp",
    skillSnapshot: [],
    archived: false,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  const other = { ...conversation, id: "conv-other", title: "Other" };

  useConversationStore.setState({
    conversations: [conversation, other],
    activeId: conversation.id,
    messages: {},
    live: {},
    pendingFreshContext: { "conv-archive": true }
  });

  await useConversationStore
    .getState()
    .archiveConversation("conv-archive", true);

  let state = useConversationStore.getState();
  assert.deepEqual(
    state.conversations.map((entry) => entry.id),
    ["conv-other"]
  );
  // Archiving the open conversation switches the main view away.
  assert.equal(state.activeId, "conv-other");
  assert.equal(state.pendingFreshContext["conv-archive"], undefined);

  await useConversationStore
    .getState()
    .archiveConversation("conv-archive", false, { ...conversation, archived: true });

  state = useConversationStore.getState();
  assert.deepEqual(
    state.conversations.map((entry) => entry.id),
    ["conv-archive", "conv-other"]
  );
  assert.equal(state.conversations[0].archived, false);
});

test("forkConversation keeps followup context so the first send sees forked history", async () => {
  const { useConversationStore, mocks } = await loadConversationStoreHarness();
  mocks.setSavedToolSession(undefined);
  const timestamp = "2026-10-28T00:00:00.000Z";
  const source = {
    id: "fork-source", title: "Fork source", agentId: "agent-1",
    agentName: "Mock ACP", adapter: "mock-acp", cwd: "/tmp/fork",
    createdAt: timestamp, updatedAt: timestamp
  };
  const history = [
    {
      id: "fork-user-1", conversationId: "fork-target", role: "user",
      status: "sent", content: "Remember the launch code is 4-2",
      createdAt: timestamp, updatedAt: timestamp
    },
    {
      id: "fork-assistant-1", conversationId: "fork-target", role: "assistant",
      status: "done",
      content: JSON.stringify([{ kind: "text", content: "Understood." }]),
      createdAt: timestamp, updatedAt: timestamp
    }
  ];
  mocks.setFollowupMessages(history);
  useConversationStore.setState({
    conversations: [source],
    messages: { [source.id]: [] },
    live: {},
    pendingFreshContext: {}
  });

  const forked = await useConversationStore.getState().forkConversation({
    conversationId: source.id,
    throughMessageId: "fork-assistant-1"
  });
  assert.equal(mocks.capturedForkInput.sourceConversationId, "fork-source");

  // The fork must not be treated like /clear: without a resumable session the
  // copied history feeds the orphan-followup context on the first send.
  assert.notEqual(
    useConversationStore.getState().pendingFreshContext[forked.id],
    true
  );

  await useConversationStore.getState().sendMessage({
    conversationId: forked.id,
    prompt: "What is the launch code?",
    userMessageId: "fork-q-user",
    assistantMessageId: "fork-q-assistant"
  });
  assert.deepEqual(mocks.capturedFollowupQuery, {
    conversationId: forked.id,
    excludeMessageIds: ["fork-q-user", "fork-q-assistant"]
  });
  assert.match(mocks.capturedRunArgs.prompt, /Remember the launch code is 4-2/);
  // No source-session resume and no fresh-context reset: a brand-new session.
  assert.equal(mocks.capturedRunArgs.toolSessionId, undefined);
  assert.equal(mocks.capturedRunArgs.resumeToolSession, true);
});
