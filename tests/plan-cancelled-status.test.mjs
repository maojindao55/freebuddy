import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const testDirectory = fileURLToPath(new URL(".", import.meta.url));
let moduleCounter = 0;

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
  const temporaryDirectory = fs.mkdtempSync(
    path.join(testDirectory, ".conversation-utils-")
  );
  const modulePath = path.join(temporaryDirectory, "conversationUtils.mjs");
  fs.writeFileSync(modulePath, output);
  try {
    moduleCounter += 1;
    return await import(`${pathToFileURL(modulePath).href}?${moduleCounter}`);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test("appendItems keeps cancelled todo plan status instead of pending", async () => {
  const { appendItems } = await loadConversationUtils();

  const items = appendItems([], [
    {
      kind: "tool-call",
      id: "todo-1",
      tool: "TodoWrite",
      input: {
        todos: [
          {
            id: "auth-classifier",
            content: "新增 authFailure 分类器",
            status: "cancelled"
          },
          {
            id: "fix-continue",
            content: "无 session 可 resume 时注入会话历史",
            status: "completed"
          }
        ]
      }
    }
  ]);

  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "plan");
  assert.deepEqual(items[0].entries, [
    {
      content: "新增 authFailure 分类器",
      priority: "medium",
      status: "cancelled"
    },
    {
      content: "无 session 可 resume 时注入会话历史",
      priority: "medium",
      status: "completed"
    }
  ]);
});
