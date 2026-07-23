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
  return import(
    `data:text/javascript;base64,${Buffer.from(output).toString("base64")}`
  );
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
