import test from "node:test";
import assert from "node:assert/strict";
import { acpModelSelectionMatches } from "../dist-electron/cli/acp.js";

test("DeepSeek model confirmation accepts the bare BYOK ID and its provider tuple", () => {
  const id = "deepseek-v4.1-flash";
  const value = JSON.stringify(["deepseek-official", id]);
  assert.equal(acpModelSelectionMatches("dsh-acp", value, id), true);
  assert.equal(acpModelSelectionMatches("dsh-acp", id, value), true);
  assert.equal(acpModelSelectionMatches("dsh-acp", value, value), true);
  assert.equal(acpModelSelectionMatches("dsh-acp", value, "glm-5.3-flash"), false);
  assert.equal(acpModelSelectionMatches("dsh-acp", JSON.stringify(["other-provider", id]), id), false);
  assert.equal(acpModelSelectionMatches("dsh-acp", '["deepseek-official"]', id), false);
});

test("other adapters keep existing model comparison semantics", () => {
  assert.equal(acpModelSelectionMatches("codex-acp", "model[high]", "model"), true);
  assert.equal(acpModelSelectionMatches("codex-acp", '["deepseek-official","model"]', "model"), false);
  assert.equal(acpModelSelectionMatches("codex-acp", "wrong-model", "model"), false);
});
