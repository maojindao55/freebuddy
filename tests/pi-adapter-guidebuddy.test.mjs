import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Pi logo SVG asset exists and has valid XML structure", () => {
  const svgPath = path.join(rootDir, "assets", "pi-logo.svg");
  assert.ok(fs.existsSync(svgPath), "assets/pi-logo.svg must exist");
  const content = fs.readFileSync(svgPath, "utf8");
  assert.match(content, /<svg[^>]*viewBox="0 0 800 800"/);
  assert.match(content, /#F09082/);
  assert.match(content, /#4D9ABF/);
  assert.match(content, /#F1BE58/);
});

test("agentIcon config maps pi-acp and pi to Pi", () => {
  const agentIconTs = fs.readFileSync(
    path.join(rootDir, "src", "config", "agentIcon.tsx"),
    "utf8"
  );
  assert.match(agentIconTs, /"pi-acp":\s*"Pi"/);
  assert.match(agentIconTs, /pi:\s*"Pi"/);
});

test("lobehubAvatarUrl intercepts Pi icon and returns bundled SVG asset", () => {
  const lobehubTs = fs.readFileSync(
    path.join(rootDir, "src", "utils", "lobehubAvatar.ts"),
    "utf8"
  );
  assert.match(lobehubTs, /import piLogoUrl from/);
  assert.match(lobehubTs, /normalized === "pi" \|\| normalized === "pi-acp"/);
});

test("GuideBuddy maintains pi-acp default runtime while ButlerBuddy defaults dynamically", () => {
  const storeTs = fs.readFileSync(
    path.join(rootDir, "src", "store", "conversationStore.ts"),
    "utf8"
  );
  assert.match(
    storeTs,
    /member\.profile === "butler"\s*\?\s*\(dynamicDefaultAdapter \?\? member\.cli\.adapter\)\s*:\s*member\.cli\.adapter/
  );

  const backendMembersTs = fs.readFileSync(
    path.join(rootDir, "electron", "cli", "members.ts"),
    "utf8"
  );
  assert.match(
    backendMembersTs,
    /member\.profile === "butler"\s*\?\s*\(dynamicDefaultAdapter \?\? member\.cli\.adapter\)\s*:\s*member\.cli\.adapter/
  );
});

test("AvatarPicker includes Pi in application icons list", () => {
  const pickerTs = fs.readFileSync(
    path.join(rootDir, "src", "components", "Settings", "AvatarPicker.tsx"),
    "utf8"
  );
  assert.match(pickerTs, /id:\s*"Pi"/);
  assert.match(pickerTs, /ALL_ICONS/);
});
