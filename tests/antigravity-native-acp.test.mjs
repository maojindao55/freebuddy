import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { buildCommand, getAdapterDefinition } from "../dist-electron/cli/adapters.js";
import { resolveAntigravitySession } from "../dist-electron/cli/antigravitySessions.js";
import { antigravityConfigOverrides, isAntigravityBridgeBinary } from "../dist-electron/shared/antigravity.js";
import { acpUpdateToItems } from "../dist-electron/cli/acp.js";
import { latestAntigravityVersion } from "../dist-electron/cli/antigravityUpdate.js";

test("Antigravity launches native ACP with isolated sessions and preserves caller flags", () => {
  assert.equal(getAdapterDefinition("agy-acp").defaultBinary, "agy");
  assert.match(getAdapterDefinition("agy-acp").installHint, /antigravity\.google\/cli\/install/);
  const built = buildCommand({ adapter: "agy-acp", prompt: "ignored", extraArgs: ["acp", "--process-per-session", "--sandbox"] });
  assert.equal(built.bin, "agy");
  assert.deepEqual(built.args, ["acp", "--process-per-session", "--sandbox"]);
  assert.equal(built.protocol, "acp");
  assert.equal(built.promptViaStdin, false);
  assert.deepEqual(buildCommand({ adapter: "agy-acp", prompt: "", extraArgs: ["--agent", "acp"] }).args,
    ["acp", "--process-per-session", "--agent", "acp"]);
});

for (const binary of ["agy-acp", "/custom/bin/agy-acp", "C:\\agent\\agy-acp.cmd", "agy-acp-bridge", "/node_modules/agy-acp-bridge/dist/index.js"]) {
  test(`explicit bridge fallback keeps its original launch contract: ${binary}`, () => {
    assert.equal(isAntigravityBridgeBinary(binary), true);
    const built = buildCommand({ adapter: "agy-acp", binary, prompt: "ignored", extraArgs: ["--sandbox"] });
    assert.equal(built.bin, binary);
    assert.deepEqual(built.args, ["--sandbox"]);
  });
}

test("bridge controls migrate without replacing an explicit native thought level", () => {
  assert.deepEqual(antigravityConfigOverrides({ model: "gpt-oss-120b", effort: "medium" }), {
    model: "gpt-oss-120b-medium", thought_level: "medium"
  });
  assert.deepEqual(antigravityConfigOverrides({ effort: "low", thought_level: "high", mode: "plan" }), {
    thought_level: "high", mode: "plan"
  });
  assert.deepEqual(antigravityConfigOverrides({ thought_level: "high" }, true), { effort: "high" });
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-agy-state-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const legacy = path.join(home, ".agy-acp-state.json");
  const modern = path.join(home, ".agy-acp", "sessions", createHash("sha256").update("bridge-id").digest("hex") + ".json");
  fs.mkdirSync(path.dirname(modern), { recursive: true });
  return { home, legacy, modern };
}

test("legacy bridge history resolves to native conversation IDs without modifying its state", t => {
  const { home, legacy } = fixture(t);
  const original = JSON.stringify({ sessions: { "bridge-id": { sessionId: "bridge-id", conversationId: "native-id" } } });
  fs.writeFileSync(legacy, original);
  assert.deepEqual(resolveAntigravitySession("bridge-id", home), { sessionId: "native-id", migrated: true });
  assert.equal(fs.readFileSync(legacy, "utf8"), original);
  assert.deepEqual(resolveAntigravitySession("other-native-id", home), { sessionId: "other-native-id", migrated: false });
});

test("atomic bridge records and tombstones take precedence over legacy state", t => {
  const { home, legacy, modern } = fixture(t);
  fs.writeFileSync(legacy, JSON.stringify({ sessions: { "bridge-id": { conversationId: "old-native" } } }));
  fs.writeFileSync(modern, JSON.stringify({ sessionId: "bridge-id", conversationId: "new-native" }));
  assert.equal(resolveAntigravitySession("bridge-id", home).sessionId, "new-native");
  fs.writeFileSync(modern, JSON.stringify({ sessionId: "bridge-id", deleted: true }));
  assert.deepEqual(resolveAntigravitySession("bridge-id", home), { migrated: true });
  fs.writeFileSync(modern, JSON.stringify({ sessionId: "bridge-id" }));
  assert.deepEqual(resolveAntigravitySession("bridge-id", home), { migrated: true });
});

test("corrupt bridge state fails visibly instead of silently discarding conversation history", t => {
  const { home, legacy, modern } = fixture(t);
  fs.writeFileSync(legacy, "not-json");
  assert.throws(() => resolveAntigravitySession("bridge-id", home));
  fs.writeFileSync(modern, JSON.stringify({ sessionId: "different-id", conversationId: "wrong-history" }));
  assert.throws(() => resolveAntigravitySession("bridge-id", home), /Invalid Antigravity/);
});

test("native assistant text is not mistaken for the bridge's error transport", () => {
  const update = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Error: is a label in this example." } };
  assert.equal(acpUpdateToItems(update, "native-id", "agy-acp", { legacyAgyBridge: false })[0].kind, "text");
  assert.equal(acpUpdateToItems(update, "bridge-id", "agy-acp", { legacyAgyBridge: true })[0].kind, "error");
});

test("native provider warning failures cannot masquerade as successful replies", () => {
  const update = { sessionUpdate: "agent_message_chunk", content: {
    type: "text", text: "\n⚠ FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n"
  } };
  const [error] = acpUpdateToItems(update, "native-id", "agy-acp", { legacyAgyBridge: false });
  assert.equal(error.kind, "error");
  assert.equal(error.terminal, true);
  assert.match(error.message, /FAILED_PRECONDITION/);
});

test("native updates use the official release, rejecting network errors and invalid tags", async () => {
  assert.equal(await latestAntigravityVersion(async url => {
    assert.equal(url, "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest");
    return { ok: true, json: async () => ({ tag_name: "1.5.9" }) };
  }), "1.5.9");
  await assert.rejects(latestAntigravityVersion(async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(latestAntigravityVersion(async () => ({ ok: true, json: async () => ({ tag_name: "not-a-version" }) })), /invalid version/);
});
