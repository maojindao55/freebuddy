import "./fixtures/electron-stub.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

let Database;
let bindingAvailable = true;
try {
  Database = (await import("better-sqlite3")).default;
  new Database(":memory:").close();
} catch {
  bindingAvailable = false;
}

function makeMockSecret({
  email,
  accessToken = `token-${email}`,
  authMethod = "consumer",
  expiry = new Date(Date.now() + 3600_000).toISOString()
}) {
  const enc = (obj) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url").replace(/=+$/, "");
  const idToken = `${enc({ alg: "none" })}.${enc({ email })}.sig`;
  const json = JSON.stringify({
    auth_method: authMethod,
    id_token: idToken,
    token: { access_token: accessToken, token_type: "Bearer", expiry }
  });
  return "go-keyring-base64:" + Buffer.from(json, "utf8").toString("base64");
}

function makeFakePoolConnection(adapter, conversationId = "conv-1") {
  const child = new EventEmitter();
  Object.assign(child, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null
  });
  const conn = {
    child,
    adapter,
    conversationId,
    fingerprint: "fp",
    sessionId: "sess-1",
    requestId: 1,
    disposals: 0,
    dispose: () => {
      conn.disposals += 1;
    }
  };
  return conn;
}

test("cli_agent_accounts schema, switching, rollback, quota refresh, pool & cache isolation", async (t) => {
  if (!bindingAvailable) {
    t.skip("better-sqlite3 native binding unavailable under this Node");
    return;
  }

  const { migrate, setDbForTest } = await import("../dist-electron/cli/db.js");
  const { resetAccountRevisionsForTest, getActiveAccountContext } = await import(
    "../dist-electron/cli/accounts/accountContext.js"
  );
  const { createAgyAccountDriver } = await import(
    "../dist-electron/cli/accounts/agyAccountDriver.js"
  );
  const { createCliAccountManager } = await import(
    "../dist-electron/cli/accounts/accountManager.js"
  );
  const { updateAccountQuota, getAccountRecord, decryptAccountCredential } = await import(
    "../dist-electron/cli/accounts/accountStore.js"
  );
  const { parseAntigravityKeyringSecret } = await import(
    "../dist-electron/cli/antigravityUsage.js"
  );
  const { saveToolSession, getToolSession, cliByokModelSignature } = await import(
    "../dist-electron/cli/store.js"
  );
  const { AcpProcessPool } = await import(
    "../dist-electron/cli/acpProcessPool.js"
  );
  const { setSetting } = await import("../dist-electron/cli/settings.js");
  const { getCachedSessionConfigOptions } = await import(
    "../dist-electron/cli/sessionConfigProbe.js"
  );

  const db = new Database(":memory:");
  setDbForTest(db);
  migrate(db);
  resetAccountRevisionsForTest();

  t.after(() => {
    setDbForTest(null);
    resetAccountRevisionsForTest();
  });

  // Verify schema migration columns
  const accountCols = db.prepare("PRAGMA table_info(cli_agent_accounts)").all();
  assert.ok(accountCols.some((c) => c.name === "credential_encrypted"));
  const toolSessionCols = db.prepare("PRAGMA table_info(cli_tool_sessions)").all();
  assert.ok(toolSessionCols.some((c) => c.name === "account_id"));

  // Fake keyring & external state
  let keyringSecret = makeMockSecret({
    email: "alice@gmail.com",
    accessToken: "alice-token-1",
    authMethod: "consumer"
  });
  let activeRuns = false;
  const disposedAdapters = [];
  const changedEvents = [];
  let loginHandler = async () => {};

  const driver = createAgyAccountDriver({
    keyring: {
      async read() {
        return keyringSecret;
      },
      async write(_s, _a, secret) {
        keyringSecret = secret;
      },
      async remove() {
        keyringSecret = null;
      }
    },
    readUsage: async ({ keyringReader }) => {
      const secret = await keyringReader();
      if (!secret) {
        return {
          ok: false,
          reason: "missing_auth",
          fetchedAt: "2026-11-24T00:00:00.000Z"
        };
      }
      const raw = JSON.parse(
        Buffer.from(secret.replace(/^go-keyring-base64:/, ""), "base64").toString(
          "utf8"
        )
      );
      if (raw.token.access_token === "expired-token") {
        return {
          ok: false,
          reason: "expired_token",
          error: "Access token is expired",
          fetchedAt: "2026-11-24T01:00:00.000Z"
        };
      }
      const isAlice = raw.token.access_token.startsWith("alice");
      return {
        ok: true,
        email: isAlice ? "alice@gmail.com" : "bob@corp.com",
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-5h",
                displayName: "Five Hour",
                window: "5h",
                windowSeconds: 18_000,
                remainingFraction: isAlice ? 0.88 : 0.42,
                usedPercent: isAlice ? 12 : 58,
                leftPercent: isAlice ? 88 : 42
              }
            ]
          }
        ],
        fetchedAt: "2026-11-24T00:30:00.000Z"
      };
    },
    runLoginTerminal: async (opts) => {
      await loginHandler(opts);
    }
  });

  const manager = createCliAccountManager({
    drivers: { "agy-acp": driver },
    hasActiveRuns: () => activeRuns,
    disposeWarmPool: (adapter) => disposedAdapters.push(adapter),
    notifyChanged: (adapter) => changedEvents.push(adapter)
  });

  // 1. Detect unimported current account
  const initialState = await manager.getAccountsState("agy-acp");
  assert.equal(initialState.supported, true);
  assert.equal(initialState.externalAccountMismatch, true);
  assert.equal(initialState.detectedSystemAccount?.identity, "alice@gmail.com");
  assert.equal(initialState.accounts.length, 0);

  // 2. Import current account + check public DTO redacts secret
  const imported = await manager.importCurrentSystemAccount("agy-acp", "Alice");
  assert.equal(imported.account.label, "Alice");
  assert.equal(imported.account.accountIdentity, "alice@gmail.com");
  assert.equal(imported.account.isActive, true);
  assert.equal(imported.account.credentialEncrypted, undefined);
  assert.equal(imported.account.quotaSnapshot?.ok, true);
  assert.equal(imported.state.externalAccountMismatch, false);

  // Duplicate import updates instead of creating duplicate row
  const importedAgain = await manager.importCurrentSystemAccount("agy-acp");
  assert.equal(importedAgain.account.id, imported.account.id);
  assert.equal(importedAgain.state.accounts.length, 1);

  // 3. Interactive login rollback on cancellation/failure preserves Alice
  loginHandler = async () => {
    throw new Error("Authentication cancelled.");
  };
  await assert.rejects(
    manager.startInteractiveAccountLogin({ adapter: "agy-acp" }, () => {}),
    /cancelled/
  );
  assert.ok(keyringSecret, "Failed login must restore previous OS keyring secret");
  assert.match(
    Buffer.from(keyringSecret.replace(/^go-keyring-base64:/, ""), "base64").toString("utf8"),
    /alice-token-1/
  );

  // 4. Interactive login success adds Bob and switches active account
  loginHandler = async ({ emit }) => {
    emit({
      type: "authentication-terminal-started",
      request: {
        requestId: "req-1",
        sessionId: "cli-accounts-agy-acp",
        agentName: "Antigravity",
        methodName: "Google Login"
      }
    });
    keyringSecret = makeMockSecret({
      email: "bob@corp.com",
      accessToken: "bob-token-1",
      authMethod: "oauth-business"
    });
  };
  const bobLogin = await manager.startInteractiveAccountLogin(
    { adapter: "agy-acp", label: "Bob Work" },
    () => {}
  );
  assert.equal(bobLogin.account.label, "Bob Work");
  assert.equal(bobLogin.account.accountIdentity, "bob@corp.com");
  assert.equal(bobLogin.account.authMethod, "oauth-business");
  assert.equal(bobLogin.account.isActive, true);
  assert.equal(bobLogin.state.accounts.length, 2);
  assert.equal(getActiveAccountContext("agy-acp").accountId, bobLogin.account.id);
  assert.ok(disposedAdapters.includes("agy-acp"));

  // 5. Switching blocked while active tasks run
  activeRuns = true;
  await assert.rejects(
    manager.switchAccount("agy-acp", imported.account.id),
    /active task is running/
  );
  activeRuns = false;

  // 6. Simulate Bob silently refreshing token in OS keyring before switching back to Alice
  keyringSecret = makeMockSecret({
    email: "bob@corp.com",
    accessToken: "bob-token-refreshed",
    authMethod: "oauth-business"
  });
  const revBeforeSwitch = getActiveAccountContext("agy-acp").revision;
  const switchedToAlice = await manager.switchAccount(
    "agy-acp",
    imported.account.id
  );
  assert.equal(switchedToAlice.account.id, imported.account.id);
  assert.equal(switchedToAlice.account.isActive, true);
  assert.ok(getActiveAccountContext("agy-acp").revision > revBeforeSwitch);
  assert.match(
    Buffer.from(keyringSecret.replace(/^go-keyring-base64:/, ""), "base64").toString("utf8"),
    /alice-token-1/
  );
  // Verify Bob's refreshed token was synced back into Bob's vault record!
  const bobRecord = getAccountRecord(bobLogin.account.id);
  assert.ok(bobRecord?.credentialEncrypted);
  const decryptedBobSecret = decryptAccountCredential(bobRecord);
  assert.ok(decryptedBobSecret);
  const parsedBobSecret = parseAntigravityKeyringSecret(decryptedBobSecret);
  assert.equal(parsedBobSecret.ok, true);
  assert.equal(parsedBobSecret.accessToken, "bob-token-refreshed");

  // 7. Unmanaged external account in OS keyring is auto-saved before switch overwrites it
  keyringSecret = makeMockSecret({
    email: "charlie@gmail.com",
    accessToken: "charlie-token-1"
  });
  const afterCharlieAutoSave = await manager.switchAccount(
    "agy-acp",
    bobLogin.account.id
  );
  assert.equal(afterCharlieAutoSave.state.accounts.length, 3);
  assert.ok(
    afterCharlieAutoSave.state.accounts.some(
      (a) => a.accountIdentity === "charlie@gmail.com"
    )
  );

  // 8. Multi-account quota refresh works without changing active OS keyring slot
  const activeSecretBeforeQuota = keyringSecret;
  const quotaRefreshed = await manager.refreshAccountQuota("agy-acp");
  assert.equal(keyringSecret, activeSecretBeforeQuota);
  const aliceAfterQuota = quotaRefreshed.accounts.find(
    (a) => a.id === imported.account.id
  );
  assert.equal(aliceAfterQuota?.quotaSnapshot?.ok, true);
  assert.equal(
    aliceAfterQuota?.quotaSnapshot?.groups[0]?.buckets[0]?.leftPercent,
    88
  );

  // 9. Expired token preserves cached groups for dimmed display
  const expiredPersist = updateAccountQuota(imported.account.id, {
    ok: false,
    reason: "expired_token",
    error: "Access token is expired",
    fetchedAt: "2026-11-24T02:00:00.000Z"
  });
  assert.equal(expiredPersist?.quotaSnapshot?.ok, false);
  assert.equal(expiredPersist?.quotaSnapshot?.reason, "expired_token");
  assert.equal(
    expiredPersist?.quotaSnapshot?.groups?.[0]?.buckets?.[0]?.leftPercent,
    88
  );
  assert.equal(
    expiredPersist?.quotaSnapshot?.cachedFetchedAt,
    "2026-11-24T00:30:00.000Z"
  );

  // 10. Tool session persists accountId and detects account switch
  saveToolSession("cli-agy-acp", "conversation:c1", "agy-acp", "native-sess-bob");
  const savedToolSess = getToolSession("cli-agy-acp", "conversation:c1");
  assert.equal(savedToolSess?.accountId, bobLogin.account.id);

  // 11. Session config probe cache separates per active account
  const probeInput = { agentId: "cli-agy-acp", adapter: "agy-acp" };
  setSetting(
    "placeholder-noop",
    "1"
  );
  // Seed cache under Bob
  await manager.switchAccount("agy-acp", bobLogin.account.id);
  const { inspectSessionConfigOptions: _unused, ...probeMod } = await import(
    "../dist-electron/cli/sessionConfigProbe.js"
  );
  void _unused;
  void probeMod;
  const cachedEmptyUnderBob = getCachedSessionConfigOptions(probeInput);
  assert.deepEqual(cachedEmptyUnderBob, []);

  // Write cached catalog for Bob via SQLite key format, switch to Alice, confirm Alice does not get Bob's catalog
  const { createHash } = await import("node:crypto");
  const ctxBob = getActiveAccountContext("agy-acp");
  const bobSig = JSON.stringify({
    agentId: "cli-agy-acp",
    adapter: "agy-acp",
    binary: "",
    extraArgs: [],
    envKeys: [],
    byokModels: cliByokModelSignature("cli-agy-acp", "agy-acp"),
    provider: "",
    accountId: ctxBob.accountId ?? "",
    accountRevision: ctxBob.revision
  });
  const bobKey = `session-config-options:${createHash("sha256").update(bobSig).digest("hex")}`;
  setSetting(
    bobKey,
    JSON.stringify({
      version: 2,
      updatedAt: new Date().toISOString(),
      options: [{ id: "model", currentValue: "bob-enterprise-model" }]
    })
  );
  assert.equal(getCachedSessionConfigOptions(probeInput)[0]?.currentValue, "bob-enterprise-model");
  await manager.switchAccount("agy-acp", imported.account.id);
  assert.deepEqual(getCachedSessionConfigOptions(probeInput), []);

  // 12. AcpProcessPool.disposeByAdapter disposes only target adapter
  const pool = new AcpProcessPool();
  const agyConn = makeFakePoolConnection("agy-acp", "c-agy");
  const otherConn = makeFakePoolConnection("codex-acp", "c-codex");
  pool.put("k-agy", agyConn);
  pool.put("k-other", otherConn);
  pool.disposeByAdapter("agy-acp");
  assert.equal(agyConn.disposals, 1);
  assert.equal(otherConn.disposals, 0);
  pool.dispose();

  // 13. Rename and delete account
  const renamed = await manager.renameAccount(bobLogin.account.id, "Bob Enterprise");
  assert.equal(renamed.account.label, "Bob Enterprise");
  const afterDelete = await manager.deleteAccount(bobLogin.account.id);
  assert.ok(!afterDelete.accounts.some((a) => a.id === bobLogin.account.id));
  assert.ok(changedEvents.length > 0);
});
