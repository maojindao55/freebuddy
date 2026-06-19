import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

async function loadConversationUtils() {
  const source = fs.readFileSync(
    new URL("../src/store/conversationUtils.ts", import.meta.url),
    "utf8"
  );
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("appendItems coalesces repeated updates for the same tool result", async () => {
  const { appendItems } = await loadConversationUtils();

  const items = appendItems(
    [
      { kind: "tool-call", id: "tool-1", tool: "bash", input: { command: "find ." } },
      { kind: "tool-result", id: "tool-1", tool: "bash", content: "find ." }
    ],
    [
      { kind: "tool-result", id: "tool-1", tool: "bash", content: "find .\nREADME.md" },
      { kind: "tool-result", id: "tool-1", tool: "bash", content: "" }
    ]
  );

  assert.deepEqual(items, [
    { kind: "tool-call", id: "tool-1", tool: "bash", input: { command: "find ." } },
    {
      kind: "tool-result",
      id: "tool-1",
      tool: "bash",
      content: "find .\nREADME.md"
    }
  ]);
});

test("appendItems deduplicates repeated bash result cards within one tool call", async () => {
  const { appendItems } = await loadConversationUtils();

  const command = "date '+%Y-%m-%d %H:%M:%S'";
  const items = appendItems(
    [
      { kind: "tool-call", id: "tool-1", tool: "bash", input: {} },
      { kind: "tool-result", id: "result-1", tool: "bash", content: command }
    ],
    [
      { kind: "tool-result", id: "result-2", tool: "bash", content: command },
      { kind: "tool-result", id: "result-3", tool: "bash", content: command }
    ]
  );

  assert.deepEqual(items, [
    { kind: "tool-call", id: "tool-1", tool: "bash", input: {} },
    { kind: "tool-result", id: "result-1", tool: "bash", content: command }
  ]);
});

test("dedupeToolResults collapses renderer duplicates with different result ids", async () => {
  const { dedupeToolResults } = await loadConversationUtils();
  const command = "date '+%Y-%m-%d %H:%M:%S %Z'";

  assert.deepEqual(
    dedupeToolResults([
      { kind: "tool-result", id: "result-1", tool: "bash", content: command },
      { kind: "tool-result", id: "result-2", tool: "bash", content: ` ${command} ` },
      { kind: "tool-result", id: "result-3", tool: "bash", content: command },
      { kind: "tool-result", id: "result-4", tool: "bash", content: command }
    ]),
    [{ kind: "tool-result", id: "result-1", tool: "bash", content: command }]
  );
});

test("appendItems deduplicates repeated command cards within one tool call", async () => {
  const { appendItems } = await loadConversationUtils();
  const command = "date '+%Y-%m-%d %H:%M:%S %Z'";

  const items = appendItems(
    [
      { kind: "tool-call", id: "tool-1", tool: "bash", input: {} },
      { kind: "command", command }
    ],
    [
      { kind: "command", command },
      { kind: "command", command },
      { kind: "command", command }
    ]
  );

  assert.deepEqual(items, [
    { kind: "tool-call", id: "tool-1", tool: "bash", input: {} },
    { kind: "command", command }
  ]);
});

test("dedupeCommands collapses renderer duplicates", async () => {
  const { dedupeCommands } = await loadConversationUtils();
  const command = "date '+%Y-%m-%d %H:%M:%S %Z'";

  assert.deepEqual(
    dedupeCommands([
      { kind: "command", command },
      { kind: "command", command: ` ${command} ` },
      { kind: "command", command }
    ]),
    [{ kind: "command", command }]
  );
});

test("stored assistant messages reuse appendItems normalization", () => {
  const source = fs.readFileSync(
    new URL("../src/components/CLI/MessageBubble.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /import \{ appendItems \} from "@\/store\/conversationUtils"/);
  assert.match(source, /out = appendItems\(out, \[next\]\)/);
});

test("tool block renderer groups command items with the tool call", () => {
  const source = fs.readFileSync(
    new URL("../src/components/CLI/MessageBubble.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /commands: Extract<CliStreamItem, \{ kind: "command" \}>\[\]/);
  assert.match(source, /next\.kind !== "tool-result" && next\.kind !== "command"/);
  assert.match(source, /commands=\{block\.commands\}/);
});

test("tool invocation renderer applies final result deduplication", () => {
  const source = fs.readFileSync(
    new URL("../src/components/CLI/StreamItem.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /import \{ dedupeCommands, dedupeToolResults \} from "@\/store\/conversationUtils"/);
  assert.match(source, /const visibleResults = dedupeToolResults\(results\)/);
  assert.match(source, /const visibleCommands = dedupeCommands\(commands\)/);
});

test("tool invocation renderer hides empty object input payloads", () => {
  const source = fs.readFileSync(
    new URL("../src/components/CLI/StreamItem.tsx", import.meta.url),
    "utf8"
  );

  assert.match(source, /Object\.keys\(value\)\.length === 0/);
  assert.match(source, /return "";/);
});
