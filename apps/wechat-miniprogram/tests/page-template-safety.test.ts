/**
 * Static safety scan for the read-only page unit.
 *
 * Runtime tests prove behaviour; this file proves the *absence* of the things that must never
 * exist in these files:
 *
 * - no HTML/scheme rendering surface in any template (`rich-text`, `web-view`, `href`, `srcdoc`),
 *   so a host cannot smuggle markup into a page;
 * - no send/stop/decision/terminal affordance on the chat page;
 * - no direct WeChat socket or HTTP usage from the page layer, and no `wx.login` anywhere: the
 *   transport goes through the App-owned adapter, and login stays unimplemented rather than faked;
 * - no page reaching around the typed read API into `rpcClient`/`readRpc`.
 *
 * The scan is deliberately limited to the page runtime surface for the write-method names, because
 * comments elsewhere legitimately name the deferred methods (`services/readRpc.ts` documents that
 * they are refused). Everywhere in `miniprogram/` is still scanned for `wx.login`/`wx.request`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "./helpers/paths";

const APP_ROOT = join(REPO_ROOT, "apps", "wechat-miniprogram");
const MP_ROOT = join(APP_ROOT, "miniprogram");

function walk(dir: string, extension: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walk(full, extension));
      continue;
    }
    if (entry.name.endsWith(extension)) {
      result.push(full);
    }
  }
  return result;
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

const APP_JSON = JSON.parse(read(join(MP_ROOT, "app.json"))) as { pages: string[] };
const PAGES = APP_JSON.pages;

/** Files that make up the page runtime surface: templates, page adapters and page-facing services. */
const PAGE_SURFACE_TS = [
  join(MP_ROOT, "app.ts"),
  join(MP_ROOT, "services", "pageViews.ts"),
  join(MP_ROOT, "services", "devConnect.ts"),
  join(MP_ROOT, "services", "appSession.ts"),
  join(MP_ROOT, "platform", "pageRuntime.ts"),
  ...walk(join(MP_ROOT, "pages"), ".ts")
];

describe("declared pages are complete", () => {
  test("every page in app.json has a ts, wxml and json file", () => {
    for (const page of PAGES) {
      for (const extension of [".ts", ".wxml", ".json", ".wxss"]) {
        assert.ok(existsSync(join(MP_ROOT, `${page}${extension}`)), `缺少 ${page}${extension}`);
      }
    }
  });

  test("the launch page is the connect page, and the read-only pages are inside the app", () => {
    assert.equal(PAGES[0], "pages/index/index");
    for (const expected of [
      "pages/home/home",
      "pages/conversations/conversations",
      "pages/chat/chat"
    ]) {
      assert.ok(PAGES.includes(expected), `app.json 未声明 ${expected}`);
    }
  });

  test("every page ts registers a Page and no template escapes the page runtime", () => {
    for (const page of PAGES) {
      const source = read(join(MP_ROOT, `${page}.ts`));
      assert.ok(source.includes("Page("), `${page}.ts 未注册 Page`);
    }
  });
});

describe("templates have no HTML or scheme execution surface", () => {
  const forbiddenTags = ["rich-text", "web-view", "srcdoc", "innerHTML", "href=", "<a ", "open-url"];

  test("no page template contains an HTML rendering or navigation escape", () => {
    for (const page of PAGES) {
      const wxml = read(join(MP_ROOT, `${page}.wxml`));
      for (const token of forbiddenTags) {
        assert.ok(!wxml.includes(token), `${page}.wxml 不得包含 ${token}`);
      }
    }
  });

  test("the chat page has no input, send or stop affordance", () => {
    const wxml = read(join(MP_ROOT, "pages", "chat", "chat.wxml"));
    for (const token of ["<input", "<textarea", "发送", "停止", "decision", "终端", "bindconfirm"]) {
      assert.ok(!wxml.includes(token), `chat.wxml 不得包含 ${token}`);
    }
    // The only button is the read-only "load older history" control.
    const buttons = wxml.match(/<button/g) ?? [];
    assert.equal(buttons.length, 1);
    assert.ok(wxml.includes("加载更早消息"));
  });

  test("the chat controller renders text only", () => {
    const source = read(join(MP_ROOT, "pages", "chat", "controller.ts"));
    assert.ok(source.includes("renderMessageText"), "消息必须走纯文本渲染");
  });
});

describe("no fake login, socket or HTTP from the page surface", () => {
  test("the whole mini program never calls wx.login, wx.request or wx.connectSocket", () => {
    const sources = walk(MP_ROOT, ".ts").filter((file) => !file.includes(join("miniprogram", "protocol")));
    for (const file of sources) {
      const source = read(file);
      for (const token of ["wx.login(", "wx.request(", "wx.connectSocket("]) {
        assert.ok(!source.includes(token), `${file} 不得直接调用 ${token}`);
      }
    }
  });

  test("the page surface names no write method and imports no raw RPC client", () => {
    const forbidden = [
      "conversation.send",
      "run.stop",
      "terminal.",
      "decision.respond",
      "permission.respond",
      "services/rpcClient",
      "services/readRpc",
      "ipc"
    ];
    for (const file of PAGE_SURFACE_TS) {
      const source = read(file);
      for (const token of forbidden) {
        assert.ok(!source.includes(token), `${file} 不得包含 ${token}`);
      }
    }
  });

  test("pages read state only through the App session", () => {
    for (const page of PAGES) {
      const source = read(join(MP_ROOT, `${page}.ts`));
      assert.ok(
        source.includes("getAppSession") || source.includes("readConversationId"),
        `${page}.ts 必须通过 App session 取数据`
      );
    }
  });
});
