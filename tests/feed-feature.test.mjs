import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");

const db = read("../electron/cli/db.ts");
const feed = read("../electron/cli/feed.ts");
const ipc = read("../electron/cli/ipc.ts");
const preload = read("../electron/preload.ts");
const types = read("../src/types/freebuddy.d.ts");
const client = read("../src/services/feed/client.ts");
const store = read("../src/store/feedStore.ts");
const settingsModal = read("../src/components/Settings/SettingsModal.tsx");
const feedTab = read("../src/components/Settings/FeedTab.tsx");
const workspacePanel = read("../src/components/CLI/WorkspacePanel.tsx");
const feedCard = read("../src/components/Feeds/FeedCard.tsx");
const en = JSON.parse(read("../src/locales/en.json"));
const zh = JSON.parse(read("../src/locales/zh-CN.json"));

test("feed tables and refresh service are wired", () => {
  assert.match(db, /CREATE TABLE IF NOT EXISTS feed_sources/);
  assert.match(db, /CREATE TABLE IF NOT EXISTS feed_items/);
  assert.match(db, /idx_feed_items_source_link/);
  assert.match(feed, /export async function refreshFeedSource/);
  assert.match(feed, /export async function refreshAllFeedSources/);
  assert.match(feed, /fetch\(source\.url/);
  assert.match(feed, /parseFeed\(xml, source\.url\)/);
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
  assert.match(settingsModal, /<FeedTab \/>/);
  assert.match(feedTab, /addSource/);
  assert.match(feedTab, /refreshAll/);
  assert.equal(en.settings.tabs.feed, "Feed");
  assert.equal(zh.settings.tabs.feed, "订阅资讯");
});

test("workspace feed card starts an interpretation conversation", () => {
  assert.match(workspacePanel, /import \{ FeedCard \}/);
  assert.match(workspacePanel, /<FeedCard \/>/);
  assert.ok(
    workspacePanel.lastIndexOf("<FeedCard />") >
      workspacePanel.indexOf('className="side-card codex-usage-card"')
  );
  assert.match(feedCard, /newConversation/);
  assert.match(feedCard, /sendMessage/);
  assert.match(feedCard, /markInterpreted/);
  assert.match(feedCard, /function isFeedInterpretConversation/);
  assert.match(feedCard, /message\.role === "user" && isFeedInterpretPrompt/);
  assert.match(feedCard, /active && isActiveFeedConversation/);
  assert.match(feedCard, /const unreadItems = useMemo/);
  assert.match(feedCard, /items\.filter\(\(item\) => !item\.interpretedAt\)/);
  assert.match(feedCard, /unreadItems\.slice\(offset, offset \+ 5\)/);
  assert.match(feedCard, /const canShuffle = unreadItems\.length > 5/);
  assert.match(feedCard, /const isRead = Boolean\(item\.interpretedAt\)/);
  assert.match(feedCard, /disabled=\{startingId !== null \|\| isRead\}/);
  assert.match(feedCard, /title: clip\(item\.title, 80\)/);
  assert.match(feedCard, /preserveConversationTitle: true/);
  assert.match(feedCard, /feed\.interpretPromptIntro/);
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
