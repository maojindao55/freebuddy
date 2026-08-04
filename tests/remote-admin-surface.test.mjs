import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (relative) =>
  fs.readFileSync(new URL(relative, import.meta.url), "utf8");

const tab = read("../src/components/Settings/RemoteTab.tsx");
const control = read("../electron/cli/remoteControl.ts");
const preload = read("../electron/preload.ts");
const en = JSON.parse(read("../src/locales/en.json"));
const zh = JSON.parse(read("../src/locales/zh-CN.json"));

function flatten(value, prefix = "") {
  return Object.entries(value).flatMap(([key, entry]) =>
    entry && typeof entry === "object"
      ? flatten(entry, `${prefix}${key}.`)
      : [`${prefix}${key}`]
  );
}

test("session, user, audit and server IPC are registered and bridged", () => {
  const channels = [
    "remote:listSessions",
    "remote:revokeSession",
    "remote:revokeUserSessions",
    "remote:revokeAllSessions",
    "remote:renameUser",
    "remote:setUserDisabled",
    "remote:setUserStrictIsolation",
    "remote:setUserPassword",
    "remote:getUserDataFootprint",
    "remote:listAuditLog",
    "remote:getServerConfig",
    "remote:setServerConfig"
  ];
  for (const channel of channels) {
    assert.ok(
      new RegExp(`registerHandler\\(\\s*"${channel}"`).test(control),
      `${channel} must be registered`
    );
    assert.ok(
      preload.includes(`ipcRenderer.invoke("${channel}"`),
      `${channel} must be exposed on the desktop preload`
    );
  }
});

test("destructive account operations write an audit entry", () => {
  for (const event of [
    "user.created",
    "user.deleted",
    "user.renamed",
    "user.password_reset",
    "user.roots_changed",
    "session.revoked",
    "session.revoked_all",
    "server.config_changed"
  ]) {
    assert.match(
      control,
      new RegExp(`event: "${event.replace(".", "\\.")}"`),
      `${event} must be audited`
    );
  }
});

test("deleting a user clears the data they own before the account row", () => {
  assert.match(control, /deleteUserOwnedData\(id\)/);
  assert.ok(
    control.indexOf("deleteUserOwnedData(id)") < control.indexOf("deleteUser(id)"),
    "owned data is removed first so the ownership query still matches"
  );

  const cleanup = read("../electron/cli/ownerCleanup.ts");
  assert.match(cleanup, /deleteConversation\(id\)/, "reuses the attachment-aware delete");
  assert.match(cleanup, /deleteScheduledTask\(id\)/);
});

test("desktop whoami falls back to the host owner for the sidebar identity", () => {
  assert.match(
    control,
    /getCallerUserId\(\)\s*\?\?\s*getOwnerUser\(\)\?\.id/,
    "desktop windows resolve to the owner account when there is no remote session"
  );
  const app = read("../src/App.tsx");
  assert.match(app, /SidebarUserMenu/, "desktop sidebar uses the same avatar + name control");
  assert.match(app, /showLogout=\{platform === "web"\}/, "logout stays web-only");
});

test("the settings page surfaces sessions, audit and server controls", () => {
  assert.match(tab, /listSessions\(\)/, "loads sessions");
  assert.match(tab, /revokeSession\(tokenHash\)/, "can sign out one device");
  assert.match(tab, /revokeAllSessions\(\)/, "can sign out everyone");
  assert.match(tab, /listAuditLog\(200\)/, "renders the activity log");
  assert.match(tab, /setServerConfig\(\{/, "exposes port and bind mode");
  assert.match(tab, /exposedOverPlainHttp/, "warns about plain HTTP exposure");
  assert.match(tab, /remote\.noRootsAssigned/, "members without roots are flagged");
  assert.match(tab, /deleteUserImpact/, "deletion shows its blast radius");
  assert.match(
    tab,
    /setInterval\(/,
    "status is refreshed instead of frozen at mount time"
  );
});

test("the settings page has no leftover dead handlers", () => {
  for (const dead of ["handleAddRoot", "handleRemoveRoot ", "selectRootsUser"]) {
    assert.ok(!tab.includes(dead), `${dead} should be gone`);
  }
});

test("remote translations stay in sync and free of dead keys", () => {
  const enKeys = flatten(en.remote).sort();
  const zhKeys = flatten(zh.remote).sort();
  assert.deepEqual(enKeys, zhKeys, "both locales define the same remote keys");

  const used = new Set();
  for (const match of tab.matchAll(/t\(\s*[`"]remote\.([a-zA-Z0-9_.]+)/g)) {
    // `remote.auditEvent.${entry.event}` is resolved at runtime; the labels are
    // covered by the audit-event test below.
    if (match[1] === "auditEvent.") continue;
    used.add(match[1]);
  }
  const unused = enKeys.filter((key) => {
    if (key.startsWith("auditEvent.")) return false;
    const base = key.replace(/_(one|other)$/, "");
    return !used.has(key) && !used.has(base);
  });
  assert.deepEqual(unused, [], "every remote string is rendered somewhere");

  const missing = [...used].filter(
    (key) => !enKeys.includes(key) && !enKeys.includes(`${key}_one`)
  );
  assert.deepEqual(missing, [], "every rendered string is defined");
});

test("every audited event has a label in both locales", () => {
  const events = [...control.matchAll(/event: "([a-z_.]+)"/g)].map((m) => m[1]);
  for (const event of new Set(events)) {
    assert.ok(en.remote.auditEvent[event], `en label missing for ${event}`);
    assert.ok(zh.remote.auditEvent[event], `zh label missing for ${event}`);
  }
});
