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
      getToolSession: async () => savedToolSession,
      updateMessage: async () => undefined,
      onEvent: () => () => {},
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
    export const debugLogClient = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined
    };
  `;
  const mockUrl = toDataUrl(mockSource);
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
    }).outputText
  );
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
        specifier === "./conversationUtils"
          ? conversationUtilsUrl
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
