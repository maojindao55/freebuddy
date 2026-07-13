import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const db = read("../electron/cli/db.ts");
const feed = read("../electron/cli/feed.ts");
const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const types = read("../src/types/freebuddy.d.ts");
const client = read("../src/services/feed/client.ts");
const store = read("../src/store/feedStore.ts");
const settingsModal = read("../src/components/Settings/SettingsModal.tsx");
const infoCardsTab = read("../src/components/Settings/InfoCardsTab.tsx");
const feedTab = read("../src/components/Settings/FeedTab.tsx");
const workspacePanel = read("../src/components/CLI/WorkspacePanel.tsx");
const infoCardHost = read("../src/components/InfoCards/InfoCardHost.tsx");
const feedCard = read("../src/components/Feeds/FeedCard.tsx");
const feedInterpretation = read("../src/components/Feeds/feedInterpretation.ts");
const styles = read("../styles.css");
const en = JSON.parse(read("../src/locales/en.json"));
const zh = JSON.parse(read("../src/locales/zh-CN.json"));

async function loadFeedCardSelectionModule() {
  const source = read("../src/components/Feeds/feedCardSelection.ts");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

function feedItem(id, sourceId, publishedAt, interpretedAt) {
  return {
    id,
    sourceId,
    sourceTitle: sourceId,
    title: id,
    link: `https://example.com/${id}`,
    publishedAt,
    interpretedAt,
    createdAt: publishedAt,
    updatedAt: publishedAt
  };
}

test("feed tables and refresh service are wired", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS feed_sources/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS feed_items/);
  assert.match(db, /idx_feed_items_source_link/);
  assert.match(feed, /export async function refreshFeedSource/);
  assert.match(feed, /export async function refreshAllFeedSources/);
  assert.match(feed, /fetchFeedXml\(source\.url\)/);
  assert.match(feed, /parseFeed\(xml, fetchedUrl\)/);
});

test("feed sources accept rsshub protocol aliases", () => {
  assert.match(feed, /const RSSHUB_DEFAULT_BASE_URL = "https:\/\/rsshub\.app"/);
  assert.match(feed, /const RSSHUB_BASE_URL_SETTING_KEY = "feed\.rsshubBaseUrl"/);
  assert.match(feed, /const RSSHUB_LEGACY_BASE_URL = "https:\/\/rsshub\.app"/);
  assert.match(feed, /export function normalizeFeedUrl/);
  assert.match(feed, /function extractRsshubErrorMessage/);
  assert.match(feed, /await response\.text\(\)/);
  assert.match(feed, /throw new Error\(`Fetch failed with HTTP \$\{response\.status\}: \$\{rsshubError\}`\)/);
  assert.match(feed, /function rsshubBaseUrl/);
  assert.match(feed, /getSetting\(RSSHUB_BASE_URL_SETTING_KEY\)/);
  assert.match(feed, /parsed\.protocol === "rsshub:"/);
  assert.match(feed, /const hasCustomInstance = parsed\.hostname\.includes\("\."\)/);
  assert.match(feed, /`https:\/\/\$\{parsed\.host\}`/);
  assert.match(feed, /function rsshubFallbackUrl/);
  assert.match(feed, /fetchFeedXml\(source\.url\)/);
});

test("settings feed tab lets users configure the RSSHub instance", () => {
  assert.match(feedTab, /RSSHUB_BASE_URL_SETTING_KEY = "feed\.rsshubBaseUrl"/);
  assert.match(feedTab, /cliClient\.getSetting\(RSSHUB_BASE_URL_SETTING_KEY\)/);
  assert.match(feedTab, /cliClient\.setSetting\(RSSHUB_BASE_URL_SETTING_KEY, normalized\)/);
  assert.match(feedTab, /feed\.rsshubBaseUrl/);
  assert.match(feedTab, /feed\.rsshubBaseUrlHelp/);
  assert.equal(en.feed.rsshubBaseUrl, "RSSHub instance");
  assert.equal(zh.feed.rsshubBaseUrl, "RSSHub 实例地址");
});

test("settings feed tab keeps subscription setup compact and scannable", () => {
  assert.match(feedTab, /const enabledCount = sources\.filter\(\(source\) => source\.enabled\)\.length/);
  assert.match(feedTab, /const errorCount = sources\.filter\(\(source\) => Boolean\(source\.lastError\)\)\.length/);
  assert.match(feedTab, /const neverFetchedCount = sources\.filter\(\(source\) => !source\.lastFetchedAt\)\.length/);
  assert.match(feedTab, /className="feed-settings-section feed-add-section"/);
  assert.match(feedTab, /className="feed-advanced"/);
  assert.match(feedTab, /className="feed-source-summary"/);
  assert.match(feedTab, /className="feed-source-details"/);
  assert.match(feedTab, /className="feed-switch"/);
  assert.doesNotMatch(feedTab, /const \[title, setTitle\]/);
  assert.doesNotMatch(feedTab, /feed\.sourceName/);
  assert.doesNotMatch(feedTab, /feed-source-status/);
  assert.match(feedTab, /feed\.rsshubRouteExample/);
  assert.match(feedTab, /feed\.enabledSummary/);
  assert.match(feedTab, /feed\.errorSummary/);
  assert.match(feedTab, /feed\.neverFetchedSummary/);
  assert.doesNotMatch(feedTab, /className="feed-summary-strip"/);
  assert.match(styles, /\.feed-settings-section/);
  assert.match(styles, /\.feed-advanced/);
  assert.match(styles, /\.feed-source-details/);
  assert.match(styles, /\.feed-switch/);
  assert.doesNotMatch(styles, /\.feed-source-status/);
  assert.match(styles, /\.feed-source-error/);
  assert.match(styles, /grid-template-columns: minmax\(260px, 1fr\) auto;/);
  assert.equal(zh.feed.sourceUrlPlaceholder, "https://example.com/feed.xml");
  assert.equal(en.feed.sourceUrlPlaceholder, "https://example.com/feed.xml");
  assert.equal(zh.feed.addSourceHint, "支持标准 RSS/Atom，也支持 rsshub:// 路由。");
  assert.equal(en.feed.addSourceHint, "Supports standard RSS/Atom feeds and rsshub:// routes.");
});

test("feed bridge is exposed across ipc preload types and client", () => {
  for (const channel of [
    "feed:listSources",
    "feed:addSource",
    "feed:updateSource",
    "feed:deleteSource",
    "feed:listItems",
    "feed:refreshSource",
    "feed:refreshAll",
    "feed:markInterpreted"
  ]) {
    assert.match(ipc, new RegExp(channel));
    assert.match(preload, new RegExp(channel));
  }
  assert.match(types, /interface FreebuddyFeed/);
  assert.match(types, /feed: FreebuddyFeed/);
  assert.match(client, /export const feedClient/);
  assert.match(store, /export const useFeedStore/);
});

test("settings modal mounts the feed management tab", () => {
  assert.match(settingsModal, /"feed" \| "about"/);
  assert.match(settingsModal, /settings\.tabs\.feed/);
  assert.match(settingsModal, /<InfoCardsTab \/>/);
  assert.match(infoCardsTab, /<FeedTab \/>/);
  assert.match(feedTab, /addSource/);
  assert.match(feedTab, /refreshAll/);
  assert.equal(en.settings.tabs.feed, "Information Cards");
  assert.equal(zh.settings.tabs.feed, "信息卡片");
});

test("workspace feed card starts an interpretation conversation", () => {
  assert.match(workspacePanel, /import \{ InfoCardHost \}/);
  assert.match(workspacePanel, /<InfoCardHost \/>/);
  assert.match(infoCardHost, /<FeedCard key=\{card\.id\} title=\{card\.title\} \/>/);
  assert.ok(
    workspacePanel.lastIndexOf("<InfoCardHost />") >
      workspacePanel.indexOf('className="side-card codex-usage-card"')
  );
  assert.match(feedCard, /newConversation/);
  assert.match(feedCard, /sendMessage/);
  assert.match(feedCard, /markInterpreted/);
  assert.match(feedCard, /isFeedInterpretConversation/);
  assert.match(feedInterpretation, /message\.role === "user" && isFeedInterpretPrompt/);
  assert.match(feedCard, /active && isActiveFeedConversation/);
  assert.match(feedCard, /getSelectableFeedItems/);
  assert.match(feedCard, /selectedSourceId/);
  assert.match(feedCard, /selectFeedCardItems\(\{[\s\S]*sourceId: effectiveSourceId/);
  assert.match(feedCard, /const canShuffle = filteredItems\.length > FEED_CARD_PAGE_SIZE/);
  assert.match(feedCard, /const isRead = Boolean\(item\.interpretedAt\)/);
  assert.match(feedCard, /disabled=\{startingId !== null \|\| isRead\}/);
  assert.match(feedCard, /title: clipFeedTitle\(item\.title\)/);
  assert.match(feedCard, /preserveConversationTitle: true/);
  assert.match(feedInterpretation, /feed\.interpretPromptIntro/);
  assert.equal(en.feed.conversationTitle, "{{title}}");
  assert.equal(zh.feed.conversationTitle, "{{title}}");
  assert.equal(en.feed.interpreted, "read");
  assert.equal(zh.feed.interpreted, "已读");
  assert.doesNotMatch(zh.feed.interpretPromptIntro, /开发工作|开发者|当前项目/);
  assert.doesNotMatch(zh.feed.interpretPromptOutput, /开发工作|开发者|当前项目/);
  assert.doesNotMatch(en.feed.interpretPromptIntro, /development work|developers|current project/i);
  assert.doesNotMatch(en.feed.interpretPromptOutput, /development work|developers|current project/i);
  assert.equal(en.feed.nextBatch, "Next batch");
  assert.equal(zh.feed.nextBatch, "换一批");
});

test("workspace feed card header filters unread items by feed source", async () => {
  const { getSelectableFeedItems, selectFeedCardItems } =
    await loadFeedCardSelectionModule();
  const sources = [
    { id: "fast", title: "Fast", enabled: true },
    { id: "mit", title: "MIT", enabled: true }
  ];
  const items = [
    feedItem("fast-1", "fast", "2026-07-05T00:10:00.000Z"),
    feedItem("mit-1", "mit", "2026-07-05T00:09:00.000Z"),
    feedItem("fast-2", "fast", "2026-07-05T00:08:00.000Z"),
    feedItem("mit-read", "mit", "2026-07-05T00:07:00.000Z", "2026-07-05T00:08:00.000Z")
  ];

  assert.deepEqual(
    getSelectableFeedItems(items, sources, "mit").map((item) => item.id),
    ["mit-1"]
  );
  assert.deepEqual(
    selectFeedCardItems({ items, sources, sourceId: "fast", pageIndex: 0 }).map(
      (item) => item.id
    ),
    ["fast-1", "fast-2"]
  );
  assert.match(feedCard, /<select[\s\S]*className="feed-source-select"/);
  assert.match(feedCard, /feed\.allSources/);
  assert.match(styles, /\.feed-source-select/);
});

test("workspace feed card opens article titles in the draft preview", () => {
  assert.match(feedCard, /useDraftPreviewStore/);
  assert.match(feedCard, /useDetailLayoutStore/);
  assert.match(feedCard, /function handlePreview/);
  assert.match(feedCard, /setPreviewTarget\(activeId, item\.link\)/);
  assert.match(feedCard, /setActiveTab\("preview"\)/);
  assert.match(feedCard, /type="button"[\s\S]*className="feed-item-title"/);
  assert.doesNotMatch(feedCard, /target="_blank"/);
});

test("workspace feed card hides when there are no unread feed items", () => {
  assert.match(feedCard, /if \(visibleItems\.length === 0\) \{/);
  assert.match(feedCard, /return null;/);
  assert.doesNotMatch(feedCard, /feed\.cardNoItems/);
  assert.doesNotMatch(feedCard, /feed\.cardNoSources/);
});

test("feed store keeps a broad item window for low-frequency sources", () => {
  assert.match(store, /const FEED_ITEM_LOAD_LIMIT = 200/);
  assert.doesNotMatch(store, /listItems\(\{ limit: 60 \}\)/);
});

test("workspace feed card balances unread items across enabled sources", async () => {
  const { selectFeedCardItems } = await loadFeedCardSelectionModule();
  const sources = [
    { id: "fast", title: "Fast", enabled: true },
    { id: "people", title: "People", enabled: true },
    { id: "mit", title: "MIT", enabled: true },
    { id: "disabled", title: "Disabled", enabled: false }
  ];
  const items = [
    feedItem("fast-1", "fast", "2026-07-05T00:10:00.000Z"),
    feedItem("fast-2", "fast", "2026-07-05T00:09:00.000Z"),
    feedItem("fast-3", "fast", "2026-07-05T00:08:00.000Z"),
    feedItem("fast-4", "fast", "2026-07-05T00:07:00.000Z"),
    feedItem("fast-5", "fast", "2026-07-05T00:06:00.000Z"),
    feedItem("mit-1", "mit", "2026-07-05T00:05:00.000Z"),
    feedItem("people-1", "people", "2026-07-05T00:04:00.000Z"),
    feedItem("disabled-1", "disabled", "2026-07-05T00:03:00.000Z"),
    feedItem("read-1", "people", "2026-07-05T00:02:00.000Z", "2026-07-05T00:03:00.000Z")
  ];

  const firstPage = selectFeedCardItems({ items, sources, pageIndex: 0 });

  assert.deepEqual(firstPage.map((item) => item.id), [
    "fast-1",
    "mit-1",
    "people-1",
    "fast-2",
    "fast-3"
  ]);
  assert.equal(
    selectFeedCardItems({ items, sources, pageIndex: 99 }).at(0).id,
    "fast-1"
  );
});

test("workspace feed card uses the shared side card typography", () => {
  assert.doesNotMatch(feedCard, /feed-card-title/);
  assert.doesNotMatch(styles, /\.feed-card-title/);
  assert.match(styles, /\.feed-item-title \{[\s\S]*?font-size: 12px;[\s\S]*?line-height: 1\.35;/);
  assert.match(styles, /\.feed-item-meta \{[\s\S]*?font-size: 11px;[\s\S]*?line-height: 1\.35;/);
});
