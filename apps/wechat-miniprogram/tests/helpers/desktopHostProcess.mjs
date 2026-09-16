/**
 * Real FreeBuddy Desktop host for the three-end integration test.
 *
 * This file is **not** part of the mini program bundle and is never shipped: it is launched by
 * `tests/remote-desktop.integration.test.ts` as a throw-away child process in Electron
 * Node-mode (`ELECTRON_RUN_AS_NODE=1`). That mode is required for a real desktop host, because
 * `better-sqlite3` in this repository is built for Electron's ABI and cannot be loaded by the
 * plain Node that runs the mini program tests.
 *
 * It consumes only the desktop entry points that `electron/remote/d4.integration.test.mjs` and
 * `electron/remote/electron-hidden-window-harness.mjs` already document — `ReadOnlyRemoteService`,
 * the `setDbForTest`/`migrate` database seam, the `cli/*` domain stores and the desktop event
 * bus. Nothing about the desktop host is re-implemented here, no desktop source is modified and
 * no desktop implementation is copied: the whole point of this process is that the frames the
 * mini program receives were produced by the *real* `AdminDispatcher`/`SnapshotService`/
 * `EventRingBuffer` over a *real* domain SQLite file.
 *
 * Everything this process creates lives in the directory named by `FB_WECHAT_IT_SQLITE`'s parent
 * (the caller removes it after the process has exited). The host token and host id arrive only
 * through the child's environment block: nothing is written to disk, nothing is printed, and the
 * channel that carries them is the same `development` handshake the D3/D4 POC uses.
 *
 * Protocol (newline-delimited JSON):
 *   stdout  {"type":"host_ready", ...} | {"type":"command_done", ...} | {"type":"host_error", ...}
 *   stdin   {"type":"rename_conversation"|"append_message"|"stop", ...}
 */

import readline from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** `apps/wechat-miniprogram/tests/helpers` -> repository root. */
const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..", "..");

function distElectron(relativePath) {
  return pathToFileURL(path.join(REPO_ROOT, "dist-electron", relativePath)).href;
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/** Bounded: a harness message must never be able to flood the parent's pipe. */
function fail(message) {
  send({ type: "host_error", message: String(message).slice(0, 512) });
  shutdown(1);
}

let service;
let database;
let dbModule;
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  try {
    service?.disable();
  } catch {
    // A failed disable must still let the rest of the teardown run.
  }
  try {
    database?.close();
  } catch {
    // See above.
  }
  try {
    dbModule?.setDbForTest(null);
  } catch {
    // See above.
  }
  process.exit(code);
}

/**
 * The seed is data, not logic: the caller owns it and passes it as JSON so there is exactly one
 * definition of the fixture. This function only writes it through the desktop's own CLI stores.
 */
function applySeed(spec) {
  const { createUser } = createUserModule;
  const { createProject } = createProjectModule;
  const { createConversation, appendMessage } = createConversationModule;

  const { user } = createUser({
    username: "remote-integration-owner",
    password: "password123",
    isOwner: true
  });
  const project = createProject({
    name: spec.project.name,
    folders: [spec.tempDir],
    primaryPath: spec.tempDir
  });

  for (const conversation of spec.conversations) {
    createConversation({
      id: conversation.id,
      title: conversation.title,
      agentId: conversation.agentId,
      agentName: conversation.agentName,
      adapter: "codex",
      projectId: project.id,
      ownerId: user.id
    });
  }

  const setMessageTime = database.prepare(
    "UPDATE conversation_messages SET created_at = ?, updated_at = ? WHERE id = ?"
  );
  for (const message of spec.messages) {
    appendMessage({
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      status: "complete",
      content: message.content
    });
    setMessageTime.run(message.createdAt, message.createdAt, message.id);
  }

  // Applied *after* the messages: `createConversation` stamps "now" and `appendMessage` moves
  // `last_message_at`, so both would otherwise leave the ordering up to wall-clock insert order
  // instead of the ordering the caller asked to assert on. The caller's timestamps are the
  // authority, and the desktop orders by `COALESCE(last_message_at, updated_at) DESC`.
  const setConversationTime = database.prepare(
    "UPDATE conversations SET updated_at = ?, last_message_at = NULL WHERE id = ?"
  );
  for (const conversation of spec.conversations) {
    setConversationTime.run(conversation.updatedAt, conversation.id);
  }

  return { ownerId: user.id, projectId: project.id };
}

let createUserModule;
let createProjectModule;
let createConversationModule;

async function main() {
  const endpoint = requireEnv("FB_WECHAT_IT_ENDPOINT");
  const hostToken = requireEnv("FB_WECHAT_IT_HOST_TOKEN");
  const hostId = requireEnv("FB_WECHAT_IT_HOST_ID");
  const sqlitePath = requireEnv("FB_WECHAT_IT_SQLITE");
  const displayName = requireEnv("FB_WECHAT_IT_DISPLAY_NAME");
  const activeRunCount = Number.parseInt(requireEnv("FB_WECHAT_IT_ACTIVE_RUNS"), 10);
  // Absent for the "the desktop restarted" case: the database already holds the domain state.
  const seedSource = process.env.FB_WECHAT_IT_SEED;

  const { default: Database } = await import("better-sqlite3");
  dbModule = await import(distElectron("cli/db.js"));
  createUserModule = await import(distElectron("cli/users.js"));
  createProjectModule = await import(distElectron("cli/projects.js"));
  createConversationModule = await import(distElectron("cli/conversations.js"));
  const { broadcastEvent } = await import(distElectron("eventBus.js"));
  const { ReadOnlyRemoteService } = await import(distElectron("remote/readOnlyService.js"));

  // A real file-backed SQLite domain store, not `:memory:`: the point of this test is the whole
  // chain, so the host must be reading from a database that actually exists on disk.
  database = new Database(sqlitePath);
  database.pragma("foreign_keys = ON");
  dbModule.migrate(database);
  dbModule.setDbForTest(database);
  let seeded = null;
  if (typeof seedSource === "string" && seedSource.length > 0) {
    const seed = JSON.parse(seedSource);
    seed.tempDir = path.dirname(sqlitePath);
    seeded = applySeed(seed);
  }

  let online = false;
  service = new ReadOnlyRemoteService({
    hostId,
    status: () => ({
      hostId,
      displayName,
      online,
      appVersion: "0.9.10",
      protocolVersion: 1,
      remoteEnabled: true,
      activeRunCount,
      pendingDecisionCount: 0,
      activeTerminalCount: 0
    })
  });
  service.enable({
    endpoint,
    development: { enabled: true, hostToken, hostId },
    onStatus: (status) => {
      online = status.state === "online";
    }
  });

  send({
    type: "host_ready",
    hostId,
    seeded: seeded !== null,
    projectId: seeded === null ? null : seeded.projectId
  });

  const commands = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  commands.on("line", (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      send({ type: "command_done", command: "invalid", ok: false });
      return;
    }
    try {
      if (command.type === "stop") {
        send({ type: "command_done", command: "stop", ok: true });
        shutdown(0);
        return;
      }
      if (command.type === "rename_conversation") {
        database
          .prepare("UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?")
          .run(command.title, command.updatedAt, command.conversationId);
        // The real desktop event bridge maps this channel to `conversation.updated` and re-reads
        // the row it just changed.
        broadcastEvent("conversations://changed", { conversationId: command.conversationId });
        send({ type: "command_done", command: command.type, ok: true });
        return;
      }
      if (command.type === "append_message") {
        createConversationModule.appendMessage({
          id: command.messageId,
          conversationId: command.conversationId,
          role: command.role,
          status: "complete",
          content: command.content
        });
        database
          .prepare("UPDATE conversation_messages SET created_at = ?, updated_at = ? WHERE id = ?")
          .run(command.createdAt, command.createdAt, command.messageId);
        broadcastEvent("messages://changed", { conversationId: command.conversationId });
        send({ type: "command_done", command: command.type, ok: true });
        return;
      }
      send({ type: "command_done", command: String(command.type), ok: false });
    } catch (error) {
      fail(error instanceof Error ? error.message : "unknown command failure");
    }
  });

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => shutdown(0));
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "desktop host harness failed");
});
