import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const cardSource = fs.readFileSync(
  new URL("../src/components/Workflows/DelegationTeamCard.tsx", import.meta.url),
  "utf8"
);
const treeSource = fs.readFileSync(
  new URL("../src/components/Workflows/DelegationTree.tsx", import.meta.url),
  "utf8"
);
const styles = fs.readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const en = JSON.parse(
  fs.readFileSync(new URL("../src/locales/en.json", import.meta.url), "utf8")
);
const zh = JSON.parse(
  fs.readFileSync(new URL("../src/locales/zh-CN.json", import.meta.url), "utf8")
);

const NEW_KEYS = [
  "viewsLabel",
  "viewRoster",
  "viewTree",
  "treeLabel",
  "expandNode",
  "collapseNode",
  "hiddenTasks",
  "orphanNote"
];

test("the tree is built from persisted parent links", () => {
  assert.match(treeSource, /flattenDelegationForest/);
  assert.match(
    cardSource,
    /const forest = useMemo\(\(\) => buildDelegationForest\(events\), \[events\]\)/
  );
});

test("the tree never fetches its own data", () => {
  assert.doesNotMatch(treeSource, /delegationClient/);
  assert.doesNotMatch(treeSource, /setTimeout|setInterval|POLL_MS/);
  assert.doesNotMatch(treeSource, /listEvents/);
  // Exactly one poller for delegation events, and it lives in the card.
  assert.equal((cardSource.match(/listEvents\(/g) ?? []).length, 1);
});

test("both views stay reachable and the roster view remains the default", () => {
  assert.match(cardSource, /const \[view, setView\] = useState<DelegationView>\("roster"\)/);
  assert.match(cardSource, /type DelegationView = "roster" \| "tree"/);
  assert.match(cardSource, /role="tablist"/);
  assert.match(cardSource, /aria-selected=\{view === "roster"\}/);
  assert.match(cardSource, /aria-selected=\{view === "tree"\}/);
  assert.match(cardSource, /workflow\.delegation\.viewRoster/);
  assert.match(cardSource, /workflow\.delegation\.viewTree/);
  // Switching conversations resets the view along with the expand state.
  assert.match(cardSource, /setView\("roster"\);\s*\n\s*\}, \[conversationId\]\)/);
});

test("tree rows expose level and sibling position to assistive tech", () => {
  assert.match(treeSource, /role="list"/);
  assert.match(treeSource, /role="listitem"/);
  assert.match(treeSource, /aria-level=\{depth \+ 1\}/);
  assert.match(treeSource, /aria-posinset=\{posInSet\}/);
  assert.match(treeSource, /aria-setsize=\{setSize\}/);
  assert.match(treeSource, /aria-expanded=\{!collapsed\}/);
  assert.match(treeSource, /workflow\.delegation\.expandNode/);
  assert.match(treeSource, /workflow\.delegation\.collapseNode/);
});

test("deep runs indent without ever growing past the panel width", () => {
  assert.match(treeSource, /const MAX_INDENT_DEPTH = 4/);
  assert.match(treeSource, /const indent = Math\.min\(depth, MAX_INDENT_DEPTH\)/);
  assert.match(treeSource, /"--fb-tree-depth": String\(indent\)/);
  assert.match(
    styles,
    /\.delegation-tree-item\s*\{[^}]*padding:[^;]*calc\(var\(--fb-tree-depth, 0\) \* 12px/s
  );
  assert.match(styles, /\.delegation-tree\s*\{[^}]*overflow-x:\s*hidden/s);
  assert.match(styles, /\.delegation-tree-item\s*\{[^}]*min-width:\s*0/s);
});

test("collapsing a node reports how many tasks it hides", () => {
  assert.match(cardSource, /const \[collapsedNodeIds, setCollapsedNodeIds\]/);
  assert.match(treeSource, /collapsedNodeIds\.has\(node\.event\.id\)/);
  assert.match(treeSource, /workflow\.delegation\.hiddenTasks/);
  assert.match(treeSource, /node\.descendantCount/);
});

test("the tree reuses the shared event detail body", () => {
  assert.match(treeSource, /<DelegationEventDetails event=\{event\} \/>/);
  assert.match(cardSource, /<DelegationEventDetails event=\{event\} \/>/);
});

test("orphaned tasks are surfaced instead of silently dropped", () => {
  assert.match(treeSource, /orphan-parent/);
  assert.match(treeSource, /workflow\.delegation\.orphanNote/);
});

test("no hook is declared after the early return", () => {
  // A hook below `if (!team) return null` changes the hook count between the
  // first render and the render where the team arrives, which makes React throw
  // "Rendered more hooks than during the previous render".
  const guardIndex = cardSource.indexOf("if (!team) return null;");
  assert.ok(guardIndex > 0, "early-return guard not found in DelegationTeamCard");
  assert.doesNotMatch(
    cardSource.slice(guardIndex),
    /use(State|Effect|Memo|Callback|Ref|LayoutEffect)\s*\(/
  );
});

test("an idle run shows a placeholder instead of a blank tree", () => {
  assert.match(treeSource, /rows\.length === 0/);
  assert.match(treeSource, /workflow\.delegation\.noActivity/);
});

test("the tree view copy exists in both locales", () => {
  for (const key of NEW_KEYS) {
    assert.equal(
      typeof en.workflow?.delegation?.[key],
      "string",
      `en.json is missing workflow.delegation.${key}`
    );
    assert.equal(
      typeof zh.workflow?.delegation?.[key],
      "string",
      `zh-CN.json is missing workflow.delegation.${key}`
    );
  }
  assert.equal(en.workflow.delegation.hiddenTasks, "{{count}} nested tasks");
  assert.match(zh.workflow.delegation.hiddenTasks, /\{\{count\}\}/);
});
