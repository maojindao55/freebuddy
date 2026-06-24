import { nanoid } from "nanoid";

import type { CliStreamItem } from "@/services/cli/parsers";
import type { ConversationMessage } from "@/services/cli/types";
import { cliClient } from "@/services/cli/client";
import { useTerminalStore } from "@/store/terminalStore";

export const DEV_TERMINAL_DEMO_LINES = [
  "$ npm test --coverage\n",
  "\n",
  "> freebuddy@ test\n> vitest run\n\n",
  " RUN  v3.x  /workspace\n\n",
  " ✓ tests/acp-terminal.test.mjs (2 tests)\n",
  " ✓ tests/stream-media.test.mjs (4 tests)\n",
  "\n",
  " Test Files  2 passed (2)\n",
  "      Tests  6 passed (6)\n",
  "   Duration  1.24s\n"
] as const;

export interface DevTerminalDemoIds {
  terminalId: string;
  toolCallId: string;
  messageId: string;
}

export function createDevTerminalDemoIds(): DevTerminalDemoIds {
  return {
    terminalId: `dev-term-${nanoid(6)}`,
    toolCallId: `dev-tool-${nanoid(6)}`,
    messageId: nanoid()
  };
}

export function buildDevTerminalDemoItems(
  ids: DevTerminalDemoIds,
  output: string,
  completed: boolean
): CliStreamItem[] {
  return [
    {
      kind: "text",
      role: "assistant",
      content: "[Dev] Simulated ACP terminal/create stream"
    },
    {
      kind: "tool-call",
      id: ids.toolCallId,
      tool: "npm test",
      toolKind: "execute",
      status: completed ? "completed" : "running",
      input: { command: "npm test --coverage", cwd: "/workspace" },
      toolOutputs: [
        {
          kind: "terminal-embed",
          terminalId: ids.terminalId,
          output,
          running: !completed,
          exited: completed,
          exitCode: completed ? 0 : undefined
        }
      ],
      replaceToolOutputs: true
    }
  ];
}

function upsertTerminalSnapshot(
  terminalId: string,
  output: string,
  completed: boolean
) {
  useTerminalStore.getState().upsert(terminalId, {
    output,
    running: !completed,
    exited: completed,
    exitCode: completed ? 0 : undefined
  });
}

const activeDemos = new Map<string, () => void>();

export function cancelDevTerminalDemo(conversationId: string) {
  const cancel = activeDemos.get(conversationId);
  cancel?.();
  activeDemos.delete(conversationId);
}

export async function startDevTerminalDemo(input: {
  conversationId: string;
  getMessages: () => ConversationMessage[];
  setMessages: (messages: ConversationMessage[]) => void;
  intervalMs?: number;
}): Promise<DevTerminalDemoIds | undefined> {
  const { conversationId, getMessages, setMessages, intervalMs = 90 } = input;
  cancelDevTerminalDemo(conversationId);

  const ids = createDevTerminalDemoIds();
  const now = new Date().toISOString();
  const assistantMessage: ConversationMessage = {
    id: ids.messageId,
    conversationId,
    role: "assistant",
    status: "running",
    content: JSON.stringify(buildDevTerminalDemoItems(ids, "", false)),
    createdAt: now,
    updatedAt: now
  };

  setMessages([...(getMessages() ?? []), assistantMessage]);
  await cliClient.appendMessage({
    id: ids.messageId,
    conversationId,
    role: "assistant",
    status: "running",
    content: assistantMessage.content
  });

  upsertTerminalSnapshot(ids.terminalId, "", false);

  let lineIndex = 0;
  let output = "";

  const applySnapshot = (completed: boolean) => {
    const items = buildDevTerminalDemoItems(ids, output, completed);
    upsertTerminalSnapshot(ids.terminalId, output, completed);
    const messages = getMessages() ?? [];
    const msgIdx = messages.findIndex((message) => message.id === ids.messageId);
    if (msgIdx < 0) return;
    const next = [...messages];
    next[msgIdx] = {
      ...next[msgIdx],
      status: completed ? "done" : "running",
      content: JSON.stringify(items),
      updatedAt: new Date().toISOString()
    };
    setMessages(next);
    void cliClient.updateMessage({
      id: ids.messageId,
      status: completed ? "done" : "running",
      content: JSON.stringify(items)
    });
  };

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (lineIndex >= DEV_TERMINAL_DEMO_LINES.length) {
        clearInterval(timer);
        activeDemos.delete(conversationId);
        applySnapshot(true);
        resolve();
        return;
      }
      output += DEV_TERMINAL_DEMO_LINES[lineIndex];
      lineIndex += 1;
      applySnapshot(false);
    }, intervalMs);

    activeDemos.set(conversationId, () => {
      clearInterval(timer);
      activeDemos.delete(conversationId);
      resolve();
    });
  });

  return ids;
}
