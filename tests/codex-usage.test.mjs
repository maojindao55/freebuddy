import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mod = await import("../dist-electron/cli/codexUsage.js");

function jwt(payload) {
  const enc = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url")
      .replace(/=+$/, "");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

test("readCodexUsage reads local Codex auth and returns sanitized usage windows", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freebuddy-codex-auth-"));
  const authPath = path.join(dir, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: jwt({
          aud: ["https://api.openai.com/v1"],
          exp: 4_102_444_800,
          "https://api.openai.com/auth": {
            chatgpt_account_id: "acct_123",
            chatgpt_plan_type: "plus"
          }
        }),
        refresh_token: "refresh-secret",
        account_id: "acct_123"
      }
    })
  );

  const calls = [];
  const result = await mod.readCodexUsage({
    authPath,
    nowMs: Date.UTC(2026, 5, 27),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            plan_type: "plus",
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 6,
                limit_window_seconds: 18000,
                reset_after_seconds: 13531,
                reset_at: 1782586824
              },
              secondary_window: {
                used_percent: 44,
                limit_window_seconds: 604800,
                reset_after_seconds: 486241,
                reset_at: 1783059534
              }
            }
          };
        }
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.planType, "plus");
  assert.deepEqual(result.primaryWindow, {
    usedPercent: 6,
    leftPercent: 94,
    windowSeconds: 18000,
    resetAfterSeconds: 13531,
    resetAt: 1782586824
  });
  assert.equal(result.secondaryWindow?.usedPercent, 44);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/wham/usage");
  assert.equal(calls[0].init.headers["chatgpt-account-id"], "acct_123");
  assert.match(calls[0].init.headers.authorization, /^Bearer /);
  assert.equal(JSON.stringify(result).includes("refresh-secret"), false);
  assert.equal(JSON.stringify(result).includes(calls[0].init.headers.authorization), false);
});

test("readCodexUsage reports unavailable when Codex auth is missing", async () => {
  const result = await mod.readCodexUsage({
    authPath: path.join(os.tmpdir(), "missing-freebuddy-codex-auth.json"),
    fetchImpl: async () => {
      throw new Error("fetch should not run");
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_auth");
});
