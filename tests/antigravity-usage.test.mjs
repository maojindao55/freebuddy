import test from "node:test";
import assert from "node:assert/strict";

const mod = await import("../dist-electron/cli/antigravityUsage.js");

function createMockKeyring(options = {}) {
  const {
    accessToken = "mock_access_token",
    expiry = new Date(Date.now() + 3600 * 1000).toISOString(),
    email = "testuser@gmail.com"
  } = options;

  const enc = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString("base64url")
      .replace(/=+$/, "");

  const idToken = `${enc({ alg: "none" })}.${enc({ email })}.sig`;

  const payload = JSON.stringify({
    auth_method: "consumer",
    id_token: idToken,
    token: {
      access_token: accessToken,
      token_type: "Bearer",
      expiry
    }
  });

  return "go-keyring-base64:" + Buffer.from(payload, "utf-8").toString("base64");
}

test("readAntigravityUsage parses quota summary successfully", async () => {
  const mockKeyring = createMockKeyring();

  const calls = [];
  const result = await mod.readAntigravityUsage({
    keyringReader: async () => mockKeyring,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            groups: [
              {
                displayName: "Gemini Models",
                description: "Gemini Flash & Pro",
                buckets: [
                  {
                    bucketId: "gemini-5h",
                    displayName: "Five Hour Limit Remaining",
                    window: "5h",
                    resetTime: "2026-09-30T12:00:00Z",
                    remainingFraction: 0.94
                  },
                  {
                    bucketId: "gemini-weekly",
                    displayName: "Weekly Limit Remaining",
                    window: "weekly",
                    resetTime: "2026-10-05T12:00:00Z",
                    remainingFraction: 0.83
                  }
                ]
              },
              {
                displayName: "Claude and GPT models",
                buckets: [
                  {
                    bucketId: "3p-5h",
                    window: "5h",
                    remainingFraction: 1.0
                  }
                ]
              },
              {
                displayName: "Gemini 4 Argon",
                description:
                  "For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.",
                buckets: [
                  {
                    bucketId: "gemini-argon-wtu-weekly",
                    displayName: "Gemini 4 Argon Weekly Limit",
                    window: "weekly",
                    resetTime: "2026-10-30T03:39:16Z",
                    remainingFraction: 0.8330965
                  }
                ]
              }
            ]
          };
        }
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.email, "testuser@gmail.com");
  assert.equal(result.groups.length, 3);

  const geminiGroup = result.groups[0];
  assert.equal(geminiGroup.displayName, "Gemini Models");
  assert.equal(geminiGroup.buckets.length, 2);

  // 5h comes first because of sorting by windowSeconds
  assert.equal(geminiGroup.buckets[0].bucketId, "gemini-5h");
  assert.equal(geminiGroup.buckets[0].leftPercent, 94);
  assert.equal(geminiGroup.buckets[0].usedPercent, 6);

  assert.equal(geminiGroup.buckets[1].bucketId, "gemini-weekly");
  assert.equal(geminiGroup.buckets[1].leftPercent, 83);
  assert.equal(geminiGroup.buckets[1].usedPercent, 17);

  const argonGroup = result.groups[2];
  assert.equal(argonGroup.displayName, "Gemini 4 Argon");
  assert.equal(argonGroup.buckets.length, 1);
  assert.equal(argonGroup.buckets[0].bucketId, "gemini-argon-wtu-weekly");
  assert.equal(argonGroup.buckets[0].window, "weekly");
  assert.equal(argonGroup.buckets[0].windowSeconds, 604_800);
  assert.equal(argonGroup.buckets[0].leftPercent, 83);
  assert.equal(argonGroup.buckets[0].usedPercent, 17);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.authorization, "Bearer mock_access_token");
  assert.match(
    calls[0].init.headers["user-agent"],
    /^antigravity\/cli\/1\.4\.6 \(aidev_client; os_type=\w+; arch=\w+\)$/
  );
});

test("readAntigravityUsage handles expired token", async () => {
  const expiredKeyring = createMockKeyring({
    expiry: new Date(Date.now() - 10000).toISOString()
  });

  const result = await mod.readAntigravityUsage({
    keyringReader: async () => expiredKeyring,
    nowMs: Date.now()
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "expired_token");
});

test("readAntigravityUsage handles missing auth", async () => {
  const result = await mod.readAntigravityUsage({
    keyringReader: async () => null
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_auth");
});
