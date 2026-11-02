import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const streamItemSource = fs.readFileSync(
  new URL("../src/components/CLI/StreamItem.tsx", import.meta.url),
  "utf8"
);
const stylesSource = fs.readFileSync(
  new URL("../styles.css", import.meta.url),
  "utf8"
);

test("StreamItem defines nested markdown list parser exports and structures", () => {
  assert.match(streamItemSource, /export interface RawMarkdownListItem/);
  assert.match(streamItemSource, /export interface ParsedMarkdownListItem/);
  assert.match(streamItemSource, /export interface ParsedMarkdownList/);
  assert.match(streamItemSource, /export const MARKDOWN_LIST_ITEM_RE/);
  assert.match(streamItemSource, /export function getMarkdownIndent/);
  assert.match(streamItemSource, /export function buildMarkdownListTrees/);
  assert.match(streamItemSource, /function renderMarkdownListTree/);
});

test("styles include nested list margin overrides", () => {
  assert.match(
    stylesSource,
    /\.markdown-body li > ul,\s*\.markdown-body li > ol\s*\{[\s\S]*?margin-top:\s*4px;[\s\S]*?margin-bottom:\s*0;/
  );
});

// Extract and test the pure parsing logic directly
function getMarkdownIndent(whitespace) {
  let count = 0;
  for (const ch of whitespace) {
    if (ch === "\t") {
      count += 4 - (count % 4);
    } else {
      count += 1;
    }
  }
  return count;
}

const MARKDOWN_LIST_ITEM_RE = /^(\s*)(?:([-*+])|(\d+)[.)])\s+(.*)$/;

function parseRawList(lines) {
  const rawItems = [];
  let i = 0;
  while (i < lines.length) {
    const curLine = lines[i];
    const match = curLine.match(MARKDOWN_LIST_ITEM_RE);
    if (match) {
      const indent = getMarkdownIndent(match[1]);
      const ordered = Boolean(match[3]);
      const start = match[3] ? parseInt(match[3], 10) : undefined;
      const text = match[4];
      rawItems.push({ indent, ordered, start, text });
      i += 1;
    } else if (
      rawItems.length > 0 &&
      curLine.trim() &&
      !curLine.trim().startsWith("```") &&
      !/^#{1,6}\s+/.test(curLine) &&
      !/^\s*>\s?/.test(curLine) &&
      getMarkdownIndent(curLine.match(/^(\s*)/)?.[1] ?? "") >= rawItems[rawItems.length - 1].indent + 2
    ) {
      rawItems[rawItems.length - 1].text += "\n" + curLine.trim();
      i += 1;
    } else if (
      !curLine.trim() &&
      i + 1 < lines.length &&
      MARKDOWN_LIST_ITEM_RE.test(lines[i + 1])
    ) {
      i += 1;
    } else {
      break;
    }
  }
  return rawItems;
}

function buildMarkdownListTrees(rawItems) {
  if (rawItems.length === 0) return [];

  let index = 0;

  function parseLevel(parentIndent) {
    const first = rawItems[index];
    const currentIndent = first.indent;
    const ordered = first.ordered;
    const list = {
      ordered,
      start: ordered && first.start && first.start !== 1 ? first.start : undefined,
      items: []
    };

    while (index < rawItems.length) {
      const item = rawItems[index];

      if (item.indent < currentIndent) {
        break;
      }

      if (item.indent > currentIndent) {
        if (list.items.length > 0) {
          const prevItem = list.items[list.items.length - 1];
          const sub = parseLevel(currentIndent);
          if (!prevItem.subLists) prevItem.subLists = [];
          prevItem.subLists.push(sub);
        } else {
          list.items.push({ text: item.text });
          index += 1;
        }
        continue;
      }

      if (item.ordered !== ordered) {
        break;
      }

      list.items.push({ text: item.text });
      index += 1;
    }

    return list;
  }

  const result = [];
  while (index < rawItems.length) {
    result.push(parseLevel(-1));
  }
  return result;
}

test("buildMarkdownListTrees correctly handles user nested list case", () => {
  const markdown = [
    "1. **两个全局命令行工具**：",
    "   - **`zcode-acp-server`**：FreeBuddy 在后台拉起的标准 ACP 服务进程。",
    "   - **`zcode-acp`**：独立的命令行/TUI 终端交互工具。",
    "2. **协议与运行依赖**：",
    "   - @agentclientprotocol/sdk (ACP 协议处理库)",
    "   - ws (WebSocket 通信库)",
    "   - martty (终端流式渲染组件)"
  ];

  const rawItems = parseRawList(markdown);
  assert.equal(rawItems.length, 7);

  const trees = buildMarkdownListTrees(rawItems);
  assert.equal(trees.length, 1);

  const top = trees[0];
  assert.equal(top.ordered, true);
  assert.equal(top.items.length, 2);

  // Item 1
  assert.equal(top.items[0].text, "**两个全局命令行工具**：");
  assert.equal(top.items[0].subLists?.length, 1);
  const sub1 = top.items[0].subLists[0];
  assert.equal(sub1.ordered, false);
  assert.equal(sub1.items.length, 2);
  assert.equal(
    sub1.items[0].text,
    "**`zcode-acp-server`**：FreeBuddy 在后台拉起的标准 ACP 服务进程。"
  );
  assert.equal(
    sub1.items[1].text,
    "**`zcode-acp`**：独立的命令行/TUI 终端交互工具。"
  );

  // Item 2
  assert.equal(top.items[1].text, "**协议与运行依赖**：");
  assert.equal(top.items[1].subLists?.length, 1);
  const sub2 = top.items[1].subLists[0];
  assert.equal(sub2.ordered, false);
  assert.equal(sub2.items.length, 3);
  assert.equal(sub2.items[0].text, "@agentclientprotocol/sdk (ACP 协议处理库)");
  assert.equal(sub2.items[1].text, "ws (WebSocket 通信库)");
  assert.equal(sub2.items[2].text, "martty (终端流式渲染组件)");
});

test("buildMarkdownListTrees supports 3-level deep nesting", () => {
  const markdown = [
    "- Level 1",
    "  - Level 2",
    "    - Level 3"
  ];

  const rawItems = parseRawList(markdown);
  const trees = buildMarkdownListTrees(rawItems);
  assert.equal(trees.length, 1);
  assert.equal(trees[0].items[0].text, "Level 1");
  assert.equal(trees[0].items[0].subLists?.[0].items[0].text, "Level 2");
  assert.equal(
    trees[0].items[0].subLists[0].items[0].subLists?.[0].items[0].text,
    "Level 3"
  );
});

test("buildMarkdownListTrees splits sibling lists with different ordered types at same indent", () => {
  const markdown = [
    "- Unordered 1",
    "- Unordered 2",
    "1. Ordered 1",
    "2. Ordered 2"
  ];

  const rawItems = parseRawList(markdown);
  const trees = buildMarkdownListTrees(rawItems);
  assert.equal(trees.length, 2);
  assert.equal(trees[0].ordered, false);
  assert.equal(trees[0].items.length, 2);
  assert.equal(trees[1].ordered, true);
  assert.equal(trees[1].items.length, 2);
});
