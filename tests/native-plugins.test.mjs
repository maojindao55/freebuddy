import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildPluginCommand,
  enrichPluginPresentation,
  listCodexDesktopPlugins,
  mergeCodexDesktopPlugins,
  normalizeMarketplacePayload,
  normalizePluginListPayload
} from "../dist-electron/cli/nativePlugins.js";

test("plugin presentation resolves manifest icons inside the plugin root", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-plugin-icon-"));
  const pluginRoot = path.join(tempRoot, "documents");
  try {
    fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "assets"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "assets", "logo.png"), "logo");
    fs.writeFileSync(path.join(pluginRoot, "assets", "logo-dark.svg"), "<svg />");
    fs.writeFileSync(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        interface: {
          logo: "./assets/logo.png",
          logoDark: "./assets/logo-dark.svg",
          brandColor: "#2563EB"
        }
      })
    );

    const enriched = enrichPluginPresentation({
      id: "documents@openai",
      name: "documents",
      installed: true,
      enabled: true,
      source: pluginRoot
    });
    assert.equal(enriched.iconPath, fs.realpathSync(path.join(pluginRoot, "assets", "logo.png")));
    assert.equal(
      enriched.iconPathDark,
      fs.realpathSync(path.join(pluginRoot, "assets", "logo-dark.svg"))
    );
    assert.equal(enriched.brandColor, "#2563EB");

    const marketplaceEnriched = enrichPluginPresentation({
      id: "documents@team",
      name: "documents",
      marketplace: "team",
      installed: false,
      enabled: false,
      source: "https://example.com/team.git"
    }, pluginRoot);
    assert.equal(
      marketplaceEnriched.iconPath,
      fs.realpathSync(path.join(pluginRoot, "assets", "logo.png"))
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("Codex desktop cache fills remote plugins omitted by the CLI", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-codex-home-"));
  const pluginRoot = path.join(
    codexHome,
    "plugins",
    "cache",
    "openai-curated-remote",
    "product-design",
    "1.2.3"
  );
  try {
    fs.mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
    fs.mkdirSync(path.join(pluginRoot, "assets"), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "assets", "logo.png"), "logo");
    fs.writeFileSync(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "product-design",
        version: "1.2.3",
        description: "Prototype product ideas",
        interface: {
          displayName: "Product Design",
          shortDescription: "Explore and prototype ideas",
          logo: "./assets/logo.png",
          brandColor: "#FF66AD"
        }
      })
    );

    const desktop = listCodexDesktopPlugins(codexHome);
    assert.equal(desktop.length, 1);
    assert.equal(desktop[0].id, "product-design@openai-curated");
    assert.equal(desktop[0].displayName, "Product Design");
    assert.equal(desktop[0].description, "Explore and prototype ideas");
    assert.equal(desktop[0].managedBy, "desktop");
    assert.equal(
      desktop[0].mentionUri,
      "plugin://product-design@openai-curated-remote"
    );

    const merged = mergeCodexDesktopPlugins([
      {
        id: "product-design@openai-curated",
        name: "product-design",
        marketplace: "openai-curated",
        installed: false,
        enabled: false,
        managedBy: "cli"
      }
    ], desktop);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].installed, true);
    assert.equal(merged[0].managedBy, "desktop");
    assert.equal(
      merged[0].mentionUri,
      "plugin://product-design@openai-curated-remote"
    );
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("Codex plugin adapter uses JSON-capable native CLI commands", () => {
  assert.deepEqual(buildPluginCommand("codex", { type: "list" }), [
    { binary: "codex", args: ["plugin", "list", "--available", "--json"] }
  ]);
  assert.deepEqual(
    buildPluginCommand("codex", {
      type: "install",
      pluginId: "review@team-market"
    }),
    [
      {
        binary: "codex",
        args: ["plugin", "add", "review@team-market", "--json"]
      }
    ]
  );
  assert.deepEqual(
    buildPluginCommand("codex", {
      type: "update",
      pluginId: "review@team-market"
    }),
    [
      {
        binary: "codex",
        args: ["plugin", "marketplace", "upgrade", "team-market", "--json"]
      }
    ]
  );
});

test("Claude plugin adapter preserves installation scope", () => {
  assert.deepEqual(
    buildPluginCommand("claude", {
      type: "install",
      pluginId: "review@team-market",
      scope: "project"
    }),
    [
      {
        binary: "claude",
        args: ["plugin", "install", "review@team-market", "--scope", "project"]
      }
    ]
  );
  assert.deepEqual(
    buildPluginCommand("claude", {
      type: "add-marketplace",
      source: "EveryInc/compound-engineering-plugin",
      ref: "main",
      scope: "user"
    }),
    [
      {
        binary: "claude",
        args: [
          "plugin",
          "marketplace",
          "add",
          "EveryInc/compound-engineering-plugin#main",
          "--scope",
          "user"
        ]
      }
    ]
  );
});

test("plugin command builder rejects option and control-character injection", () => {
  assert.throws(
    () => buildPluginCommand("codex", { type: "install", pluginId: "--help" }),
    /Invalid plugin id/
  );
  assert.throws(
    () =>
      buildPluginCommand("claude", {
        type: "add-marketplace",
        source: "owner/repo\nmalicious"
      }),
    /Invalid marketplace source/
  );
});

test("plugin list normalization accepts Codex and Claude JSON shapes", () => {
  const codex = normalizePluginListPayload({
    installed: [
      {
        pluginId: "documents@openai",
        name: "documents",
        marketplaceName: "openai",
        version: "1.2.3",
        installed: true,
        enabled: true,
        source: { source: "local", path: "/plugins/documents" }
      }
    ],
    available: [
      {
        pluginId: "review@openai",
        name: "review",
        marketplaceName: "openai",
        installed: false
      }
    ]
  });
  assert.equal(codex.length, 2);
  assert.equal(codex[0].id, "documents@openai");
  assert.equal(codex[0].source, "/plugins/documents");
  assert.equal(codex[1].installed, false);

  const claude = normalizePluginListPayload([
    {
      id: "review@team-market",
      name: "review",
      marketplace: "team-market",
      version: "2.0.0",
      enabled: false,
      scope: "project"
    }
  ]);
  assert.equal(claude[0].marketplace, "team-market");
  assert.equal(claude[0].scope, "project");
  assert.equal(claude[0].enabled, false);
});

test("marketplace normalization accepts arrays and keyed objects", () => {
  assert.deepEqual(
    normalizeMarketplacePayload({
      marketplaces: [{ name: "openai", root: "/market/openai" }]
    }),
    [{ name: "openai", root: "/market/openai" }]
  );
  assert.deepEqual(
    normalizeMarketplacePayload({
      team: { source: { source: "github", repo: "owner/repo" } }
    }),
    [{ name: "team", source: "owner/repo" }]
  );
});

test("plugin management is wired through settings, preload, and IPC", () => {
  const read = (file) => fs.readFileSync(new URL(file, import.meta.url), "utf8");
  const settings = read("../src/components/Settings/SettingsModal.tsx");
  const ui = read("../src/components/Settings/PluginsTab.tsx");
  const preload = read("../electron/preload.ts");
  const ipc = read("../electron/cli/ipc.ts");
  const css = read("../styles.css");
  assert.match(settings, /activeTab === "plugins"/);
  assert.match(ui, /plugins\.marketplaceSourcePlaceholder/);
  assert.match(ui, /pluginsClient\.addMarketplace/);
  assert.match(ui, /plugins-heading-actions/);
  assert.match(ui, /plugins-marketplace-dialog/);
  assert.match(ui, /attachmentPreviewUrl\(plugin\.iconPath\)/);
  assert.match(ui, /loading="lazy"/);
  assert.match(ui, /plugin\.managedBy === "desktop"/);
  assert.match(ui, /selectedMarketplace/);
  assert.match(ui, /plugin\.marketplace === selectedMarketplace/);
  assert.match(ui, /plugins\.allMarketplaces/);
  assert.match(ui, /aria-pressed=\{selectedMarketplace === marketplace\.name\}/);
  assert.doesNotMatch(ui, /className="plugins-marketplace-add"/);
  assert.match(preload, /plugins:addMarketplace/);
  assert.match(ipc, /plugins:updateMarketplace/);
  assert.match(css, /\.settings-surface label\.plugins-search\s*\{[^}]*flex-direction:\s*row/s);
  assert.match(css, /\.plugins-list\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*scroll/s);
  assert.match(css, /\.plugins-workspace\s*\{[^}]*flex:\s*1 1 auto[^}]*min-height:\s*0/s);
  assert.doesNotMatch(css, /\.plugins-section-title span\s*\{[^}]*margin-left:\s*auto/s);
});
