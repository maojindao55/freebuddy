import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadSessionMetaUtils() {
  const source = fs.readFileSync(
    new URL("../src/store/sessionMetaUtils.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText.replaceAll('"@freebuddy/cli-stream"', JSON.stringify(import.meta.resolve("@freebuddy/cli-stream")));
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("sessionMetaUtils prefers live items over persisted message items", async () => {
  const { mergeSessionMetaItems } = await loadSessionMetaUtils();

  const messageItems = [
    {
      kind: "available-commands",
      commands: [{ name: "old", description: "Old command" }]
    },
    {
      kind: "config-options",
      options: [
        {
          id: "model",
          name: "Model",
          type: "select",
          category: "model",
          currentValue: "gpt-4",
          currentLabel: "GPT-4",
          values: []
        }
      ]
    }
  ];
  const liveItems = [
    {
      kind: "available-commands",
      commands: [{ name: "brainstorming", description: "Explore ideas" }]
    }
  ];

  const merged = mergeSessionMetaItems(messageItems, liveItems);
  assert.deepEqual(merged.commands, [
    { name: "brainstorming", description: "Explore ideas" }
  ]);
  assert.equal(merged.configOptions[0].currentValue, "gpt-4");
});

test("sessionMetaUtils reads the latest metadata from assistant messages", async () => {
  const { latestAvailableCommandsFromMessages, latestSessionInfoFromMessages } =
    await loadSessionMetaUtils();

  const messages = [
    {
      role: "assistant",
      content: JSON.stringify([
        {
          kind: "available-commands",
          commands: [{ name: "first", description: "First" }]
        },
        { kind: "text", role: "assistant", content: "hello" }
      ])
    },
    {
      role: "assistant",
      content: JSON.stringify([
        {
          kind: "session",
          sessionId: "sess-1",
          title: "Renamed session",
          updatedAt: "2026-06-23T12:00:00.000Z"
        }
      ])
    }
  ];

  assert.deepEqual(latestAvailableCommandsFromMessages(messages), [
    { name: "first", description: "First" }
  ]);
  assert.deepEqual(latestSessionInfoFromMessages(messages), {
    kind: "session",
    sessionId: "sess-1",
    title: "Renamed session",
    updatedAt: "2026-06-23T12:00:00.000Z"
  });
});

test("session metadata ignores legacy command lists persisted as truncated strings", async () => {
  const { latestAvailableCommandsFromItems, latestAvailableCommandsFromMessages, mergeSessionMetaItems } =
    await loadSessionMetaUtils();
  for (const commands of ['[{"name":"help"},\n… [truncated]', { name: "help" }, null, 42]) {
    const items = [{ kind: "available-commands", commands }];
    const messages = [{ role: "assistant", content: JSON.stringify(items) }];
    assert.deepEqual(latestAvailableCommandsFromItems(items), []);
    assert.deepEqual(latestAvailableCommandsFromMessages(messages), []);
    assert.deepEqual(mergeSessionMetaItems(items, undefined).commands, []);
  }
});

test("invalid live command metadata falls back to usable persisted commands", async () => {
  const { mergeSessionMetaItems } = await loadSessionMetaUtils();
  const saved = [{ kind: "available-commands", commands: [{ name: "help" }] }];
  const live = [{ kind: "available-commands", commands: "… [truncated]" }];
  assert.deepEqual(mergeSessionMetaItems(saved, live).commands, [{ name: "help" }]);
});

test("malformed command entries cannot crash filtering or rendering", async () => {
  const { mergeSessionMetaItems } = await loadSessionMetaUtils();
  const items = [{
    kind: "available-commands",
    commands: [
      null, "help", {}, { name: 123 }, { name: " " },
      { name: " help ", description: "Show help", inputHint: "topic" },
      { name: "review", description: { text: "bad" }, inputHint: ["bad"] }
    ]
  }];
  const { commands } = mergeSessionMetaItems(items, undefined);
  assert.deepEqual(commands, [
    { name: "help", description: "Show help", inputHint: "topic" },
    { name: "review" }
  ]);
  assert.deepEqual(commands.filter(command => command.name.toLowerCase().startsWith("h")), [commands[0]]);
});
