import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("ShareExtension Info.plist conforms to Apple share-services specification", () => {
  const plistPath = path.join(
    rootDir,
    "desktop",
    "macos",
    "ShareExtension",
    "Info.plist"
  );
  assert.ok(fs.existsSync(plistPath), "Info.plist should exist");

  const content = fs.readFileSync(plistPath, "utf-8");
  assert.match(content, /com\.apple\.share-services/, "Must specify com.apple.share-services");
  assert.match(content, /ShareViewController/, "Must specify ShareViewController");
  assert.match(content, /NSExtensionActivationSupportsText/, "Must support text activation");
  assert.match(content, /NSExtensionActivationSupportsFileWithMaxCount/, "Must support file activation");
  assert.match(content, /NSExtensionActivationSupportsImageWithMaxCount/, "Must support image activation");
  assert.match(content, /发送到 FreeBuddy/, "Display name should be 发送到 FreeBuddy");
});

test("ShareViewController.swift exists and defines complete lifecycle", () => {
  const swiftPath = path.join(
    rootDir,
    "desktop",
    "macos",
    "ShareExtension",
    "ShareViewController.swift"
  );
  assert.ok(fs.existsSync(swiftPath), "ShareViewController.swift should exist");

  const swiftCode = fs.readFileSync(swiftPath, "utf-8");
  assert.match(swiftCode, /@objc\(ShareViewController\)/);
  assert.match(swiftCode, /freebuddy:\/\/share\?id=/);
  assert.match(swiftCode, /extensionContext\?\.completeRequest/);
  assert.match(swiftCode, /extensionContext\?\.cancelRequest/);
  assert.match(swiftCode, /UTType\.fileURL\.identifier/);
  assert.match(swiftCode, /UTType\.plainText\.identifier/);
  assert.match(swiftCode, /UTType\.image\.identifier/);
});

test("Electron main handles freebuddy://share action", () => {
  const mainTs = fs.readFileSync(
    path.join(rootDir, "electron", "main.ts"),
    "utf-8"
  );
  assert.match(mainTs, /action === "share"/);
  assert.match(mainTs, /handleExternalShare/);
  assert.match(mainTs, /freebuddy:\/\/external-share/);
  assert.match(mainTs, /managed-attachments/);
});

test("Preload exposes onExternalShare listener", () => {
  const preloadTs = fs.readFileSync(
    path.join(rootDir, "electron", "preload.ts"),
    "utf-8"
  );
  assert.match(preloadTs, /onExternalShare/);
  assert.match(preloadTs, /freebuddy:\/\/external-share/);
});

test("Electron main automatically registers macOS share extension on startup", () => {
  const mainTs = fs.readFileSync(
    path.join(rootDir, "electron", "main.ts"),
    "utf-8"
  );
  assert.match(mainTs, /ensureMacShareExtensionRegistered/);
  assert.match(mainTs, /pluginkit/);
  assert.match(mainTs, /dev\.freebuddy\.app\.share/);
  assert.match(mainTs, /dev\.freebuddy\.app\.dev\.share/);
});

