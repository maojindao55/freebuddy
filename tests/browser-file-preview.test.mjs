import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ipcSource = fs.readFileSync(new URL("../electron/cli/ipc.ts", import.meta.url), "utf8");
const browserCanvasSource = fs.readFileSync(
  new URL("../src/components/Browser/BrowserCanvas.tsx", import.meta.url),
  "utf8"
);
const browserToolbarSource = fs.readFileSync(
  new URL("../src/components/Browser/BrowserToolbar.tsx", import.meta.url),
  "utf8"
);
const feedCardSource = fs.readFileSync(
  new URL("../src/components/Feeds/FeedCard.tsx", import.meta.url),
  "utf8"
);

async function loadBrowserStoreModule() {
  const source = fs.readFileSync(
    new URL("../src/store/browserStore.ts", import.meta.url),
    "utf8"
  );
  const output = ts
    .transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
      }
    })
    .outputText.replace(
      /^import \{ create \} from "zustand";\s*$/m,
      "const create = (factory) => factory(() => {}, () => ({}));"
    )
    .replace(
      /^import \{[^}]*\} from "@\/utils\/chatAttachments";\s*$/m,
      [
        "const attachmentPreviewUrl = (filePath) => {",
        '  const normalized = String(filePath || "").trim().replace(/\\\\/g, "/");',
        "  if (!normalized) return \"\";",
        '  if (typeof window !== "undefined" && window.freebuddy?.platform === "web") {',
        "    const params = new URLSearchParams({ path: normalized });",
        "    const token = window.freebuddy.sessionToken?.()?.trim();",
        '    if (token) params.set("token", token);',
        '    return `/api/attachment?${params.toString()}`;',
        "  }",
        '  return `freebuddy-file://open?path=${encodeURIComponent(normalized)}`;',
        "};",
        "const withWebMediaAuth = (url, extra) => {",
        "  if (!url) return \"\";",
        '  const parsed = new URL(url, "http://local.invalid");',
        '  if (typeof window !== "undefined" && window.freebuddy?.platform === "web") {',
        "    const token = window.freebuddy.sessionToken?.()?.trim();",
        '    if (token) parsed.searchParams.set("token", token);',
        "  }",
        "  if (extra) for (const [k, v] of Object.entries(extra)) parsed.searchParams.set(k, v);",
        '  return parsed.protocol.startsWith("http")',
        "    ? `${parsed.pathname}${parsed.search}${parsed.hash}`",
        "    : parsed.toString();",
        "};"
      ].join("\n")
    );
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

async function loadBrowserCanvasModule() {
  const source = fs.readFileSync(
    new URL("../src/components/Browser/BrowserCanvas.tsx", import.meta.url),
    "utf8"
  );
  const output = ts
    .transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
      }
    })
    .outputText.replace(/import[\s\S]*?from "react";\n/, "")
    .replace(/import[\s\S]*?from "react-i18next";\n/, "")
    .replace(/import[\s\S]*?from "@\/services\/cli\/client";\n/, "")
    .replace(/import[\s\S]*?from "@\/store\/conversationStore";\n/, "")
    .replace(/import[\s\S]*?from "@\/store\/browserStore";\n/, "")
    .replace(/import[\s\S]*?from "\.\/BrowserToolbar";\n/, "")
    .replace(/import[\s\S]*?from "\.\.\/CLI\/StreamItem";\n/, "");
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

test("Browser preview keeps freebuddy-file image URLs as direct image sources", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const source = "freebuddy-file://open?path=%2Ftmp%2Fgenerated%20poster.png";
  const url = composeBrowserUrl("/Users/me/workspace", source, 7);
  const parsed = new URL(url);

  assert.equal(parsed.protocol, "freebuddy-file:");
  assert.equal(parsed.hostname, "open");
  assert.equal(parsed.searchParams.get("path"), "/tmp/generated poster.png");
});

test("Browser image detection reads extension from freebuddy-file path query", async () => {
  const { isImageBrowserTarget } = await loadBrowserCanvasModule();
  const source = "freebuddy-file://open?path=%2Ftmp%2Fgenerated%20poster.png";

  assert.equal(isImageBrowserTarget(source, source), true);
  assert.equal(isImageBrowserTarget("freebuddy-file://open?path=%2Ftmp%2Fnotes.txt", ""), false);
});

test("Browser image detection reads extension from /api/attachment path query", async () => {
  const { isImageBrowserTarget, browserTargetExtension } = await loadBrowserCanvasModule();
  const source = "/api/attachment?path=%2Ftmp%2Fgenerated%20poster.png&freebuddyBrowser=3";

  assert.equal(browserTargetExtension(undefined, source), "png");
  assert.equal(isImageBrowserTarget(undefined, source), true);
  assert.equal(
    isImageBrowserTarget(undefined, "/api/attachment?path=%2Ftmp%2Fnotes.txt"),
    false
  );
});

test("Browser preview converts absolute local image paths to freebuddy-file URLs", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const previous = globalThis.window;
  globalThis.window = undefined;
  try {
    const filePath = path.normalize("/tmp/generated poster.png").replace(/\\/g, "/");
    const url = composeBrowserUrl("/Users/me/workspace", filePath, 3);
    const parsed = new URL(url);

    assert.equal(parsed.protocol, "freebuddy-file:");
    assert.equal(parsed.hostname, "open");
    assert.equal(decodeURIComponent(parsed.searchParams.get("path") ?? ""), filePath);
  } finally {
    globalThis.window = previous;
  }
});

test("Browser preview converts absolute local image paths to /api/attachment on web", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const previous = globalThis.window;
  globalThis.window = { freebuddy: { platform: "web" } };
  try {
    const filePath = path.normalize("/tmp/generated poster.png").replace(/\\/g, "/");
    const url = composeBrowserUrl("/Users/me/workspace", filePath, 3);
    const parsed = new URL(url, "http://local.invalid");

    assert.equal(parsed.pathname, "/api/attachment");
    assert.equal(decodeURIComponent(parsed.searchParams.get("path") ?? ""), filePath);
  } finally {
    globalThis.window = previous;
  }
});

test("Browser preview converts workspace-relative HTML to /api/browser-render on web", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const previous = globalThis.window;
  globalThis.window = { freebuddy: { platform: "web" } };
  try {
    const url = composeBrowserUrl("/Users/me/workspace", "index.html", 4);
    const parsed = new URL(url, "http://local.invalid");

    assert.equal(parsed.pathname, "/api/browser-render/%2FUsers%2Fme%2Fworkspace/index.html");
    assert.equal(parsed.searchParams.get("v"), "4");
  } finally {
    globalThis.window = previous;
  }
});

test("Browser preview resolves workspace-relative images to absolute file preview URLs", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const previous = globalThis.window;
  try {
    globalThis.window = { freebuddy: { platform: "web" } };
    const webUrl = composeBrowserUrl(
      "/Users/me/workspace",
      "generated-images/poster.png",
      4
    );
    const webParsed = new URL(webUrl, "http://local.invalid");
    assert.equal(webParsed.pathname, "/api/attachment");
    assert.equal(
      decodeURIComponent(webParsed.searchParams.get("path") ?? ""),
      "/Users/me/workspace/generated-images/poster.png"
    );

    globalThis.window = undefined;
    const desktopUrl = composeBrowserUrl(
      "/Users/me/workspace",
      "generated-images/poster.png",
      2
    );
    const desktopParsed = new URL(desktopUrl);
    assert.equal(desktopParsed.protocol, "freebuddy-file:");
    assert.equal(
      decodeURIComponent(desktopParsed.searchParams.get("path") ?? ""),
      "/Users/me/workspace/generated-images/poster.png"
    );
  } finally {
    globalThis.window = previous;
  }
});

test("Browser preview converts file:// HTML URLs to render URLs without a workspace", async () => {
  const { composeBrowserUrl, pathFromFileUrl } = await loadBrowserStoreModule();
  const source =
    "file:///Applications/FreeBuddy.app/Contents/Resources/app.asar/dist/games/xiangqi/index.html";
  const url = composeBrowserUrl("", source, 6);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "render");
  assert.equal(
    parsed.pathname,
    "/%2FApplications%2FFreeBuddy.app%2FContents%2FResources%2Fapp.asar%2Fdist%2Fgames%2Fxiangqi/index.html"
  );
  assert.equal(parsed.searchParams.get("v"), "6");
  assert.equal(
    pathFromFileUrl(source),
    "/Applications/FreeBuddy.app/Contents/Resources/app.asar/dist/games/xiangqi/index.html"
  );
});

test("Browser preview converts Windows file:// HTML URLs without a workspace", async () => {
  const { composeBrowserUrl, pathFromFileUrl } = await loadBrowserStoreModule();
  const source = "file:///C:/Users/me/FreeBuddy/dist/games/gomoku/index.html";
  const url = composeBrowserUrl("", source, 2);
  const parsed = new URL(url);

  assert.equal(
    pathFromFileUrl(source),
    "C:/Users/me/FreeBuddy/dist/games/gomoku/index.html"
  );
  assert.equal(parsed.hostname, "render");
  assert.equal(
    parsed.pathname,
    "/C%3A%2FUsers%2Fme%2FFreeBuddy%2Fdist%2Fgames%2Fgomoku/index.html"
  );
});

test("bundled game entry uses HTTP on web and an absolute path in packaged Electron", async () => {
  const { bundledGameEntry } = await loadBrowserStoreModule();
  const previous = globalThis.window;
  try {
    globalThis.window = {
      freebuddy: { platform: "web" },
      location: { origin: "http://127.0.0.1:9", href: "http://127.0.0.1:9/" }
    };
    assert.equal(
      bundledGameEntry("xiangqi"),
      "http://127.0.0.1:9/games/xiangqi/index.html"
    );

    globalThis.window = {
      freebuddy: { platform: "darwin" },
      location: {
        href: "file:///Applications/FreeBuddy.app/Contents/Resources/app.asar/dist/index.html"
      }
    };
    assert.equal(
      bundledGameEntry("xiangqi"),
      "/Applications/FreeBuddy.app/Contents/Resources/app.asar/dist/games/xiangqi/index.html"
    );
  } finally {
    globalThis.window = previous;
  }
});

test("Browser preview converts absolute HTML paths to render URLs without a workspace", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const filePath = "/Users/me/docs/v2ex_discussion.html";
  const url = composeBrowserUrl("", filePath, 5);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "render");
  assert.equal(parsed.pathname, "/%2FUsers%2Fme%2Fdocs/v2ex_discussion.html");
  assert.equal(parsed.searchParams.get("v"), "5");
});

test("Browser preview converts absolute markdown paths to render URLs without a workspace", async () => {
  const { composeBrowserUrl, splitAbsoluteLocalFile } =
    await loadBrowserStoreModule();
  const filePath = "/Users/me/docs/notes.md";
  const url = composeBrowserUrl("", filePath, 2);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "render");
  assert.equal(parsed.pathname, "/%2FUsers%2Fme%2Fdocs/notes.md");
  assert.equal(parsed.searchParams.get("v"), "2");
  assert.deepEqual(splitAbsoluteLocalFile(filePath), {
    root: "/Users/me/docs",
    rel: "notes.md"
  });
});

test("Browser preview prefers absolute HTML roots over conversation cwd", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const filePath = "/tmp/outside/page.html";
  const url = composeBrowserUrl("/Users/me/workspace", filePath, 9);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "render");
  assert.equal(parsed.pathname, "/%2Ftmp%2Foutside/page.html");
});

test("Browser preview keeps remote article URLs inside the preview target", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const source = "https://example.com/article?from=rss";
  const url = composeBrowserUrl("/Users/me/workspace", source, 11);
  const parsed = new URL(url);

  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname, "example.com");
  assert.equal(parsed.pathname, "/article");
  assert.equal(parsed.searchParams.get("from"), "rss");
});

test("Browser preview keeps remote HTTP URLs exact inside the preview target", async () => {
  const { composeBrowserUrl, remoteBrowserOrigin } = await loadBrowserStoreModule();
  const source = "http://w.gangpeitong.cloud:2011/dashboard";
  assert.equal(remoteBrowserOrigin(source), "http://w.gangpeitong.cloud:2011");

  const url = composeBrowserUrl("/Users/me/workspace", source, 11);
  assert.equal(url, "http://w.gangpeitong.cloud:2011/dashboard");
});

test("Browser preview supports remote URLs but not relative files without a workspace", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const remote = composeBrowserUrl("", "https://example.com/article", 4);

  assert.equal(new URL(remote).hostname, "example.com");
  assert.equal(composeBrowserUrl("", "index.html", 4), "");
});

test("Browser canvas loads absolute markdown via readBrowserMarkdown without a workspace", () => {
  assert.match(browserCanvasSource, /splitAbsoluteLocalFile/);
  assert.match(
    browserCanvasSource,
    /const root = absolute\?\.root \?\? cwd/
  );
  assert.match(
    browserCanvasSource,
    /const fileRel = absolute\?\.rel \?\? rel/
  );
  assert.match(browserCanvasSource, /readBrowserMarkdown\(root, fileRel\)/);
  assert.doesNotMatch(browserCanvasSource, /fetch\(entry\.url\)/);
});

test("Browser preview keeps WeChat article URLs exact because they are signed", async () => {
  const { composeBrowserUrl } = await loadBrowserStoreModule();
  const source = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=abc#rd";
  const url = composeBrowserUrl("/Users/me/workspace", source, 11);
  const parsed = new URL(url);

  assert.equal(parsed.hostname, "mp.weixin.qq.com");
  assert.equal(parsed.searchParams.get("__biz"), "test");
  assert.equal(parsed.hash, "#rd");
});

test("Browser preview keeps WeChat external-only as a non-native fallback", async () => {
  const { isExternalOnlyBrowserTarget } = await loadBrowserCanvasModule();
  const source = "https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1&sn=abc#rd";

  assert.equal(isExternalOnlyBrowserTarget(source), true);
  assert.equal(isExternalOnlyBrowserTarget("https://example.com/article"), false);
  assert.match(browserCanvasSource, /!isNativeRemote && isExternalOnlyBrowserTarget/);
  assert.match(browserCanvasSource, /browser\.externalOnlyTitle/);
  assert.match(browserCanvasSource, /browser-external-only/);
});

test("Browser external open supports remote article URLs", () => {
  assert.match(ipcSource, /\^https\?:\\\/\\\//);
  assert.doesNotMatch(ipcSource, /https\?:\\\/\\\/\(localhost\|127/);
});

test("Browser external open supports freebuddy-file preview URLs", () => {
  assert.match(ipcSource, /resolveAttachmentFilePath/);
  assert.match(ipcSource, /url\.startsWith\("freebuddy-file:\/\/"\)/);
  assert.match(ipcSource, /pathToFileURL\(filePath\)\.toString\(\)/);
});

test("Browser toolbar shows feed actions only when a feed item is active", () => {
  assert.match(browserToolbarSource, /feedItem\?: FeedItem/);
  assert.match(browserToolbarSource, /onInterpretFeedItem\?: \(item: FeedItem\) => void/);
  assert.match(browserToolbarSource, /onMarkFeedItemRead\?: \(item: FeedItem\) => void/);
  assert.match(browserToolbarSource, /feedItem && \(/);
  assert.match(browserToolbarSource, /browser\.feedInterpret/);
  assert.match(browserToolbarSource, /browser\.feedMarkRead/);
});

test("Browser canvas wires feed preview actions to the active feed item", () => {
  assert.match(browserCanvasSource, /useFeedStore/);
  assert.match(browserCanvasSource, /currentFeedItem/);
  assert.match(browserCanvasSource, /item\.link === entry\?\.manualEntry/);
  assert.match(browserCanvasSource, /markInterpreted\(item\.id\)/);
  assert.match(browserCanvasSource, /buildFeedInterpretPrompt\(item, t\)/);
  assert.match(browserCanvasSource, /feedItem=\{currentFeedItem\}/);
  assert.match(browserCanvasSource, /onInterpretFeedItem=\{handleInterpretFeedItem\}/);
  assert.match(browserCanvasSource, /onMarkFeedItemRead=\{handleMarkFeedItemRead\}/);
});

test("Feed interpretation logic is shared by card and browser actions", () => {
  assert.match(feedCardSource, /from "\.\/feedInterpretation"/);
  assert.doesNotMatch(feedCardSource, /function buildInterpretPrompt/);
  assert.doesNotMatch(feedCardSource, /function isFeedInterpretConversation/);
});

test("Browser store normalizes cwd across slashes, dots, and case", async () => {
  const { normalizeBrowserCwd, isSameBrowserCwd } = await loadBrowserStoreModule();

  assert.equal(normalizeBrowserCwd("."), "");
  assert.equal(normalizeBrowserCwd(""), "");
  assert.equal(normalizeBrowserCwd(undefined), "");
  assert.equal(
    normalizeBrowserCwd("C:\\Users\\me\\workspace\\"),
    "C:/Users/me/workspace"
  );
  assert.equal(
    normalizeBrowserCwd("/Users/me/workspace/"),
    "/Users/me/workspace"
  );

  assert.equal(
    isSameBrowserCwd("C:\\Users\\me\\workspace", "C:/Users/me/workspace/"),
    true
  );
  assert.equal(
    isSameBrowserCwd("c:\\users\\me\\workspace", "C:\\Users\\me\\workspace"),
    true
  );
  assert.equal(isSameBrowserCwd(".", ""), true);
  assert.equal(isSameBrowserCwd("/a", "/b"), false);
});

