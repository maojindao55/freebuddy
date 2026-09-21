import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PI_BYOK_EXTENSION_SOURCE,
  ensurePiByokExtension,
  ensurePiSettings,
  findLastPiSessionErrorMessage
} from "../dist-electron/cli/piRuntime.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return fs.readFileSync(path.join(rootDir, rel), "utf8");
}

test("BYOK extension is written into pi's global extension dir and is idempotent", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pi-byok-"));
  const file = ensurePiByokExtension(dataDir);
  assert.equal(file, path.join(dataDir, "pi-agent", "extensions", "freebuddy-byok.js"));

  const first = fs.readFileSync(file, "utf8");
  assert.match(first, /registerProvider/);
  assert.match(first, /FREEBUDDY_PI_BYOK/);

  // Rewriting identical content leaves the file untouched.
  const before = fs.statSync(file).mtimeMs;
  ensurePiByokExtension(dataDir);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test("extension never embeds secrets and honours the protocol mapping", () => {
  // Config (including the key) must arrive via env, not be baked into the file.
  assert.match(PI_BYOK_EXTENSION_SOURCE, /process\.env\.FREEBUDDY_PI_BYOK/);
  assert.doesNotMatch(PI_BYOK_EXTENSION_SOURCE, /sk-[A-Za-z0-9]/);
  assert.match(PI_BYOK_EXTENSION_SOURCE, /api: config\.api \|\| "openai-completions"/);
  assert.match(PI_BYOK_EXTENSION_SOURCE, /"freebuddy-relay"/);
  assert.match(PI_BYOK_EXTENSION_SOURCE, /apiKey/);
  assert.match(PI_BYOK_EXTENSION_SOURCE, /\$"\s*\+\s*envVar/);
});

test("pi BYOK resolves to env + FREEBUDDY_PI_BYOK payload with protocol mapping", () => {
  const store = read("electron/cli/store.ts");
  assert.match(store, /export function resolvePiByokEnv\(/);
  assert.match(store, /resolvePiByokEnv\(agentId, adapter, selectedModel\)/);
  assert.match(store, /export function piApiForProtocol\(/);
  assert.match(store, /if \(protocol === "anthropic"\) return "anthropic-messages"/);
  assert.match(store, /if \(protocol === "openai-responses"\) return "openai-responses"/);
  // Provider-reference and official-member fallback paths.
  assert.match(store, /resolveByokWithProvider\(overrideId, "pi"\)/);
  assert.match(store, /resolveByokWithProvider\("pi-acp", "pi"\)/);
});

test("piByok is persisted end to end (types, column, upsert, read-back)", () => {
  const store = read("electron/cli/store.ts");
  assert.match(store, /export interface CLIPiByokConfig/);
  assert.match(store, /piByok\?: CLIPiByokConfig/);
  assert.match(store, /function normalizePiByokForStorage\(/);
  assert.match(store, /pi_byok: \(\(\) => \{/);
  assert.match(store, /piByok: readByokPublic<CLIPiByokConfig>\(r\.pi_byok\)/);

  const db = read("electron/cli/db.ts");
  assert.match(db, /ALTER TABLE cli_executor_overrides ADD COLUMN pi_byok TEXT/);

  const types = read("src/services/cli/types.ts");
  assert.match(types, /export interface CLIPiByokConfig/);
  assert.match(types, /piByok\?: CLIPiByokConfig/);
});

test("pi providers accept OpenAI/Anthropic/Responses relays", () => {
  const types = read("src/services/providers/types.ts");
  assert.match(types, /if \(id === "pi-acp"\) \{/);
  assert.match(types, /p === "anthropic"/);
});

test("onboarding overlay is model-free and gated by the onboarding store", () => {
  const overlay = read("src/components/Onboarding/OnboardingWelcomeOverlay.tsx");
  // No LLM round-trip on first paint: only the gateway activation call.
  assert.doesNotMatch(overlay, /cliClient\.(run|send|start)/);
  assert.match(overlay, /activateGuideTrial/);
  assert.match(overlay, /markSkipped/);
  assert.match(overlay, /onOpenSettings\("providers"\)/);

  const store = read("src/store/onboardingStore.ts");
  assert.match(store, /ONBOARDING_STATE_SETTING_KEY/);
  assert.match(store, /hasConfiguredModelAccess/);
  // Existing installs with a configured provider must never see the overlay.
  assert.match(store, /if \(hasConfiguredModelAccess\(\)\)/);
  assert.match(store, /resolved: "done", open: false/);

  const app = read("src/App.tsx");
  assert.match(app, /useOnboardingStore\.getState\(\)\.evaluate\(\)/);
  assert.match(app, /<OnboardingWelcomeOverlay onOpenSettings=\{openSettings\} \/>/);
});

test("gateway client posts the device id and never ships a shared key", () => {
  const client = read("src/services/onboarding/gatewayClient.ts");
  assert.match(client, /X-FreeBuddy-Device-Id/);
  assert.match(client, /getOrCreateDeviceId/);
  assert.match(client, /GUIDE_GATEWAY_ACTIVATE_PATH/);
  // A leaked upstream key would look like a hardcoded sk-/Bearer literal.
  assert.doesNotMatch(client, /"sk-[A-Za-z0-9]{8,}"/);
});

test("ensurePiSettings writes and pins defaultProvider and defaultModel idempotently", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pi-settings-"));
  ensurePiSettings(dataDir, {
    defaultProvider: "freebuddy-relay",
    defaultModel: "deepseek-v4-flash"
  });
  const settingsFile = path.join(dataDir, "pi-agent", "settings.json");
  assert.equal(fs.existsSync(settingsFile), true);
  const parsed = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.equal(parsed.defaultProvider, "freebuddy-relay");
  assert.equal(parsed.defaultModel, "deepseek-v4-flash");

  const before = fs.statSync(settingsFile).mtimeMs;
  ensurePiSettings(dataDir, {
    defaultProvider: "freebuddy-relay",
    defaultModel: "deepseek-v4-flash"
  });
  assert.equal(fs.statSync(settingsFile).mtimeMs, before);
});

test("pi BYOK resolves default model and avoids exposing custom relay keys in OPENAI_API_KEY", () => {
  const store = read("electron/cli/store.ts");
  assert.match(store, /export function resolvePiByokDefaultModel\(/);
  assert.match(store, /FREEBUDDY_PI_RELAY_KEY/);
  assert.match(store, /isCustomBaseUrl/);
  assert.match(store, /resolveByokWithProvider\("pi-acp", "pi"\)/);
});

test("acpRuntime and conversationStore auto-apply default Pi BYOK model", () => {
  const acpRuntime = read("electron/cli/acpRuntime.ts");
  assert.match(acpRuntime, /resolvePiByokDefaultModel/);
  assert.match(acpRuntime, /overrides\.model = defaultPiModel/);
  assert.match(acpRuntime, /isPiByok/);

  const convStore = read("src/store/conversationStore.ts");
  assert.match(convStore, /defaultPiByokModel/);
  assert.match(convStore, /freebuddy-relay\//);
});

test("findLastPiSessionErrorMessage extracts errorMessage from pi session jsonl", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fb-pi-err-"));
  const cwdDir = path.join(tempDir, "pi-agent", "sessions", "--Users-test--");
  fs.mkdirSync(cwdDir, { recursive: true });

  const testSessionId = "01a0b825-test-session-id";
  const sessionFilePath = path.join(cwdDir, `2026-09-19T00-00-00-000Z_${testSessionId}.jsonl`);

  fs.writeFileSync(
    sessionFilePath,
    [
      JSON.stringify({ type: "session", id: testSessionId }),
      JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: "401: {\"code\":16,\"message\":\"Forbidden\"}"
        }
      })
    ].join("\n") + "\n"
  );

  const found = findLastPiSessionErrorMessage(tempDir, testSessionId);
  assert.equal(found, '401: {"code":16,"message":"Forbidden"}');

  assert.equal(findLastPiSessionErrorMessage(tempDir, "non-existent-session"), undefined);
  assert.equal(findLastPiSessionErrorMessage(undefined, testSessionId), undefined);
});

