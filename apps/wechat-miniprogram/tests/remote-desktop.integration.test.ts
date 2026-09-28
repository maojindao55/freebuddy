/**
 * Three-end acceptance: WeChat mini program ⇄ real Go Relay ⇄ real Electron desktop host.
 *
 * Every other integration test in this directory substitutes one end: `relay-integration` and
 * `relay-resume` drive the production `adminConnection` against a real Go Relay but answer RPCs
 * from a scripted stand-in host, and `electron/remote/*.integration.test.mjs` drives the real
 * desktop host with a hand-written admin socket. Neither can show that the *pages* an operator
 * actually uses are fed by a *real* desktop host over a *real* Relay.
 *
 * This file closes that gap and nothing else. It assembles the production path end to end:
 *
 *   createAppSession (real assembly: one socket, one RPC client, one resume manager, DEV gate)
 *     -> real `AdminConnection` over a real WebSocket (`wx.connectSocket` is the only seam)
 *     -> temporary Go Relay built from `services/remote-relay` on a random loopback port
 *     -> real `ReadOnlyRemoteService` in a throw-away Electron Node-mode process, reading a real
 *        file-backed SQLite domain store (see `helpers/desktopHostProcess.mjs`)
 *     -> the page controllers (`home`, `conversations`, `chat`) that render for the operator.
 *
 * What it therefore proves: the operator's home/conversation/message data *is* the data in the
 * desktop's own database, that paging is served by the desktop's `AdminDispatcher`, that live
 * events and resume/snapshot fallback travel the whole chain, and that unloading a page or
 * signing out cannot leave a cache, a cursor or a credential behind.
 *
 * What it deliberately does **not** claim: this is not a WeChat DevTools or real-device GUI run,
 * it is not a real `wx.login`/`code2Session` administrator session (the DEV operator token is the
 * only credential the Relay implements), and it does not use a real AppID or a filed domain. The
 * mini program README keeps those as unverified.
 *
 * Secrets: the Relay's temporary `DEV_AUTH_*` tokens are generated in this process, passed to the
 * children only through their environment blocks, and asserted absent from the Relay's output,
 * the desktop host's output and the mini program's storage. Every temporary directory created
 * here is removed after the children have exited.
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import type { ResolvedEnvironment } from "../miniprogram/config/runtimeConfig";
import { createChatController, type ChatPageData } from "../miniprogram/pages/chat/controller";
import {
  createConversationsController,
  type ConversationsPageData
} from "../miniprogram/pages/conversations/controller";
import { createHomeController, type HomePageData } from "../miniprogram/pages/home/controller";
import { createAppSession, type AppSession } from "../miniprogram/services/appSession";
import { RESUME_CURSOR_STORAGE_KEY } from "../miniprogram/services/resumeCursorStorage";
import { ROUTES } from "../miniprogram/services/pageViews";
import { resetAdminStores } from "../miniprogram/stores/adminStores";
import { resetHostTargetRegistry } from "../miniprogram/config/hostTarget";
import { resetOperatorTokenSession } from "../miniprogram/services/adminSession";
import type { SocketTaskLike } from "../miniprogram/platform/wechatApi";

import { createFakeWechatApi, type RecordingWechatApi } from "./helpers/fakeWechatApi";
import { createRecordingPageRuntime, type RecordedRuntime } from "./helpers/fakePageRuntime";
import { REPO_ROOT } from "./helpers/paths";
import { cleanupRelayBuild, startRelay, type RelayInstance } from "./helpers/relayProcess";
import { createRealSocketTask } from "./helpers/realSocket";
import { delay, waitFor } from "./helpers/wait";

/* --------------------------------------------------------------------------------------------
 * Fixture. The desktop host seeds whatever this describes, so there is exactly one definition of
 * the expected data and the assertions below can state the values independently of the harness.
 * ------------------------------------------------------------------------------------------ */

const CONVERSATION_COUNT = 60;
/** More than the mini program's 50-item page, so a second page is required. */
const CONVERSATION_PAGE = 50;
/**
 * The desktop's own `sync.snapshot` window. `snapshotService.snapshot(conversationLimit = 50)`
 * caps the conversations a snapshot carries regardless of how many the database holds, so a
 * cached 50-item page and the replacement snapshot happen to be the same size — the assertions
 * below therefore pin the desktop's documented window, not the client's page size.
 */
const SNAPSHOT_CONVERSATION_WINDOW = 50;
const TARGET_CONVERSATION_INDEX = 0;
const MESSAGE_COUNT = 55;
/** A second conversation with its own messages: proves `message.list` is conversation-scoped. */
const OTHER_CONVERSATION_INDEX = 10;
const OTHER_MESSAGE_COUNT = 3;
/**
 * The conversation the owner renames mid-session. The rename moves its `updated_at` past every
 * seeded row, which is what makes it the desktop's newest row — see
 * `expectedSnapshotOrderAfterRenames`.
 */
const RENAMED_CONVERSATION_INDEX = 5;
const HOST_DISPLAY_NAME = "FreeBuddy three-end host";
const ACTIVE_RUN_COUNT = 3;

const SEED_EPOCH_MS = Date.parse("2026-09-14T09:00:00.000Z");

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function conversationId(index: number): string {
  return `conv_it_${pad(index, 3)}`;
}

function conversationTitle(index: number): string {
  return `Conversation ${pad(index, 2)}`;
}

/** Newest first: `listConversations` orders by `COALESCE(last_message_at, updated_at) DESC`. */
function conversationUpdatedAt(index: number): string {
  return new Date(SEED_EPOCH_MS - index * 60_000).toISOString();
}

function messageId(index: number): string {
  return `msg_it_${pad(index, 3)}`;
}

function messageContent(index: number): string {
  return `message ${pad(index, 2)}`;
}

function messageRole(index: number): "user" | "assistant" {
  return index % 2 === 0 ? "user" : "assistant";
}

function messageCreatedAt(index: number): string {
  return new Date(SEED_EPOCH_MS + index * 1_000).toISOString();
}

const TARGET_CONVERSATION = conversationId(TARGET_CONVERSATION_INDEX);
const OTHER_CONVERSATION = conversationId(OTHER_CONVERSATION_INDEX);

/**
 * The order the desktop's own list query produces once the owner has renamed
 * `RENAMED_CONVERSATION_INDEX`: `COALESCE(last_message_at, updated_at) DESC`, with
 * `last_message_at` cleared for every seeded conversation. The rename therefore puts that
 * conversation's `updated_at` ahead of the `SEED_EPOCH_MS` row 0 and of every `index * 60_000`
 * row behind it, so the desktop — not the client — decides that it comes first.
 */
function expectedSnapshotOrderAfterRenames(): string[] {
  const renamed = conversationId(RENAMED_CONVERSATION_INDEX);
  return [
    renamed,
    ...Array.from({ length: CONVERSATION_COUNT }, (_unused, index) => conversationId(index)).filter(
      (id) => id !== renamed
    )
  ];
}

interface SeedSpec {
  readonly project: { readonly name: string };
  readonly conversations: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly agentId: string;
    readonly agentName: string;
    readonly updatedAt: string;
  }>;
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly conversationId: string;
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly createdAt: string;
  }>;
}

function buildSeed(): SeedSpec {
  const conversations = Array.from({ length: CONVERSATION_COUNT }, (_unused, index) => ({
    id: conversationId(index),
    title: conversationTitle(index),
    agentId: "agent_it",
    agentName: "Three-end agent",
    updatedAt: conversationUpdatedAt(index)
  }));

  const messages = Array.from({ length: MESSAGE_COUNT }, (_unused, index) => ({
    id: messageId(index),
    conversationId: TARGET_CONVERSATION,
    role: messageRole(index),
    content: messageContent(index),
    createdAt: messageCreatedAt(index)
  }));

  for (let index = 0; index < OTHER_MESSAGE_COUNT; index += 1) {
    messages.push({
      id: `msg_other_${pad(index, 3)}`,
      conversationId: OTHER_CONVERSATION,
      role: "user",
      content: `other ${pad(index, 2)}`,
      createdAt: new Date(SEED_EPOCH_MS + index * 1_000).toISOString()
    });
  }

  return { project: { name: "FreeBuddy three-end project" }, conversations, messages };
}

/* --------------------------------------------------------------------------------------------
 * Prerequisites. The desktop half of this test needs the repository's desktop build output, the
 * Electron runtime and the Go toolchain — none of which belong to `apps/wechat-miniprogram`, and
 * none of which this component may build or modify. When they are absent the test reports why it
 * cannot run instead of quietly asserting less.
 * ------------------------------------------------------------------------------------------ */

const DESKTOP_HOST_SCRIPT = join(
  REPO_ROOT,
  "apps",
  "wechat-miniprogram",
  "tests",
  "helpers",
  "desktopHostProcess.mjs"
);
const DESKTOP_OUTPUT = join(REPO_ROOT, "dist-electron");
const ELECTRON_PACKAGE = join(REPO_ROOT, "node_modules", "electron");

function resolveElectronBinary(): string | null {
  try {
    const relative = readFileSync(join(ELECTRON_PACKAGE, "path.txt"), "utf8").trim();
    const binary = join(ELECTRON_PACKAGE, "dist", relative);
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

function hasGoToolchain(): boolean {
  try {
    return spawnSync("go", ["version"], { encoding: "utf8" }).status === 0;
  } catch {
    return false;
  }
}

function describeMissingPrerequisite(): string | null {
  if (!existsSync(join(DESKTOP_OUTPUT, "remote", "readOnlyService.js"))) {
    return "desktop build output dist-electron/ is missing; run `npm run build:electron` at the repository root";
  }
  if (!existsSync(DESKTOP_HOST_SCRIPT)) {
    return `desktop host harness is missing at ${DESKTOP_HOST_SCRIPT}`;
  }
  if (resolveElectronBinary() === null) {
    return "the electron package is not installed; run `npm install` at the repository root";
  }
  if (!hasGoToolchain()) {
    return "the go toolchain is not on PATH; the Relay is built from services/remote-relay";
  }
  return null;
}

const MISSING_PREREQUISITE = describeMissingPrerequisite();
const SKIP = MISSING_PREREQUISITE ?? false;

/* --------------------------------------------------------------------------------------------
 * Harness plumbing.
 * ------------------------------------------------------------------------------------------ */

type JsonRecord = Record<string, unknown>;

function framesOfType(frames: readonly string[], type: string): JsonRecord[] {
  return frames
    .map((frame) => JSON.parse(frame) as JsonRecord)
    .filter((frame) => frame.type === type);
}

function rpcRequests(frames: readonly string[], method: string): JsonRecord[] {
  return framesOfType(frames, "rpc.request").filter((frame) => {
    const payload = frame.payload as { method?: string } | undefined;
    return payload?.method === method;
  });
}

function paramsOf(frame: JsonRecord): JsonRecord {
  return (frame.payload as { params?: JsonRecord }).params ?? {};
}

/** Frames this client put on the wire (and the socket URLs it opened). */
interface Wire {
  readonly sent: string[];
  readonly received: string[];
  readonly socketUrls: string[];
}

/**
 * The only substitution on the mini program side, exactly as documented for the other
 * integration tests: `wx.connectSocket` becomes a real WebSocket. Framing, admission, the state
 * machine, RPC correlation and the sequence gate are all the production ones.
 */
function createWireApi(wire: Wire): RecordingWechatApi {
  const base = createFakeWechatApi({ envVersion: "develop" });
  return {
    ...base,
    connectSocket(options) {
      wire.socketUrls.push(options.url);
      const task: SocketTaskLike = createRealSocketTask(options.url);
      return {
        send(data) {
          wire.sent.push(data);
          task.send(data);
        },
        close(code, reason) {
          task.close(code, reason);
        },
        onOpen(listener) {
          task.onOpen(listener);
        },
        onMessage(listener) {
          task.onMessage((event) => {
            if (typeof event.data === "string") {
              wire.received.push(event.data);
            }
            listener(event);
          });
        },
        onError(listener) {
          task.onError(listener);
        },
        onClose(listener) {
          task.onClose(listener);
        }
      };
    }
  };
}

interface DesktopHost {
  readonly child: ChildProcess;
  readonly stdout: readonly string[];
  readonly stderr: () => string;
  command(command: JsonRecord): Promise<JsonRecord>;
  stop(): Promise<void>;
}

interface Fixture {
  readonly relay: RelayInstance;
  readonly tempDir: string;
  readonly sqlitePath: string;
  readonly hostId: string;
  readonly seed: SeedSpec;
}

interface ThreeEnd {
  readonly fixture: Fixture;
  readonly host: DesktopHost;
  readonly session: AppSession;
  readonly api: RecordingWechatApi;
  readonly runtime: RecordedRuntime;
  readonly wire: Wire;
  readonly dispose: () => Promise<void>;
}

function childExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childExited(child)) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const onExit = (): void => finish(true);
    function finish(result: boolean): void {
      clearTimeout(timeout);
      child.removeListener("exit", onExit);
      resolve(result);
    }
    child.once("exit", onExit);
  });
}

async function createFixture(): Promise<Fixture> {
  // The App-scoped stores, host target and credential session are process-wide singletons; this
  // file creates several sessions, so each one starts from the state a fresh launch would have.
  resetAdminStores();
  resetHostTargetRegistry();
  resetOperatorTokenSession();

  const relay = await startRelay();
  const tempDir = mkdtempSync(join(tmpdir(), "fb-three-end-"));
  return {
    relay,
    tempDir,
    sqlitePath: join(tempDir, "domain.sqlite"),
    hostId: relay.hostId,
    seed: buildSeed()
  };
}

async function startDesktopHost(
  fixture: Fixture,
  options: { readonly reseed: boolean }
): Promise<DesktopHost> {
  const binary = resolveElectronBinary();
  assert.ok(binary !== null, "the electron package must be installed to run this test");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    FB_WECHAT_IT_ENDPOINT: fixture.relay.hostSocketUrl,
    FB_WECHAT_IT_HOST_TOKEN: fixture.relay.hostToken,
    FB_WECHAT_IT_HOST_ID: fixture.hostId,
    FB_WECHAT_IT_SQLITE: fixture.sqlitePath,
    FB_WECHAT_IT_DISPLAY_NAME: HOST_DISPLAY_NAME,
    FB_WECHAT_IT_ACTIVE_RUNS: String(ACTIVE_RUN_COUNT)
  };
  if (options.reseed) {
    env.FB_WECHAT_IT_SEED = JSON.stringify(fixture.seed);
  } else {
    delete env.FB_WECHAT_IT_SEED;
  }

  const child = spawn(binary, [DESKTOP_HOST_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: ["pipe", "pipe", "pipe"],
    env
  });

  const stdout: string[] = [];
  const stderrChunks: string[] = [];
  let remainder = "";
  let hostError: string | null = null;
  const commandWaiters: Array<(message: JsonRecord) => void> = [];
  let ready = false;
  let readyWaiter: (() => void) | null = null;

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    remainder += chunk;
    const lines = remainder.split("\n");
    remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      stdout.push(line);
      // Bounded: the parent never accumulates an unbounded child transcript.
      if (stdout.length > 200) {
        stdout.shift();
      }
      let message: JsonRecord;
      try {
        message = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }
      if (message.type === "host_error") {
        hostError = String(message.message);
      }
      if (message.type === "host_ready") {
        ready = true;
        readyWaiter?.();
        readyWaiter = null;
      }
      if (message.type === "command_done") {
        const waiter = commandWaiters.shift();
        waiter?.(message);
      }
    }
  });
  child.stderr?.on("data", (chunk: string) => {
    stderrChunks.push(chunk);
    if (stderrChunks.length > 40) {
      stderrChunks.shift();
    }
  });

  const stderr = (): string => stderrChunks.join("");
  const exited = (): string | null =>
    childExited(child) ? `desktop host exited (code=${child.exitCode}, signal=${child.signalCode})` : null;

  const failure = (): string =>
    `${hostError ?? exited() ?? "desktop host did not report readiness"}; stderr: ${stderr().slice(-600)}`;

  const deadline = Date.now() + 60_000;
  while (!ready && Date.now() < deadline) {
    if (hostError !== null || childExited(child)) {
      throw new Error(failure());
    }
    await new Promise<void>((resolve) => {
      readyWaiter = resolve;
      const timer = setTimeout(() => {
        if (readyWaiter === resolve) {
          readyWaiter = null;
          resolve();
        }
      }, 50);
      timer.unref?.();
    });
  }
  if (!ready) {
    child.kill("SIGKILL");
    throw new Error(failure());
  }

  return {
    child,
    stdout,
    stderr,

    command(command) {
      if (!child.stdin || child.stdin.destroyed) {
        throw new Error(`desktop host stdin is closed; ${failure()}`);
      }
      const pending = new Promise<JsonRecord>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`desktop host did not answer ${String(command.type)}; ${failure()}`));
        }, 15_000);
        commandWaiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return pending;
    },

    async stop() {
      if (childExited(child)) {
        return;
      }
      try {
        child.stdin?.write(`${JSON.stringify({ type: "stop" })}\n`);
      } catch {
        // Escalate to signals below.
      }
      if (await waitForExit(child, 10_000)) {
        return;
      }
      child.kill("SIGTERM");
      if (await waitForExit(child, 5_000)) {
        return;
      }
      child.kill("SIGKILL");
      if (!(await waitForExit(child, 5_000))) {
        throw new Error("the temporary desktop host did not exit; its temporary directory was not removed");
      }
    }
  };
}

function relayWsBaseUrl(fixture: Fixture): string {
  const url = new URL(fixture.relay.httpBaseUrl);
  return `ws://${url.host}`;
}

async function connectSession(fixture: Fixture, wire: Wire): Promise<{
  readonly session: AppSession;
  readonly api: RecordingWechatApi;
  readonly runtime: RecordedRuntime;
}> {
  const api = createWireApi(wire);
  // The `local` environment, narrowed to this run's random loopback port. The DEV gate re-checks
  // that both endpoints are literal loopback addresses, and `release` builds never reach here.
  const environment: ResolvedEnvironment = {
    name: "local",
    httpBaseUrl: fixture.relay.httpBaseUrl,
    wsBaseUrl: relayWsBaseUrl(fixture),
    debugLogging: true,
    source: "policy"
  };
  const session = createAppSession({ api, environment, clientVersion: "0.0.0-three-end-it" });
  session.start();

  assert.equal(session.dev.arm().available, true, "the DEV gate must allow a loopback connection");
  assert.equal(session.dev.setHostId(fixture.hostId).accepted, true);
  const credential = session.dev.setToken(fixture.relay.adminToken);
  assert.equal(credential.accepted, true, credential.reason ?? "the DEV token must be accepted");
  assert.equal(session.dev.connect().connected, true);

  await waitFor(
    () => (session.connection.getSnapshot().status === "online" ? true : null),
    15_000,
    "the admin socket to authenticate against the real Relay"
  );
  await waitFor(
    () => (session.connection.resume.state(fixture.hostId).materialized ? true : null),
    15_000,
    "the authoritative snapshot from the real desktop host to be applied"
  );
  return { session, api, runtime: createRecordingPageRuntime() };
}

async function provision(options: { readonly reseed: boolean }): Promise<ThreeEnd> {
  const fixture = await createFixture();
  const wire: Wire = { sent: [], received: [], socketUrls: [] };
  let host: DesktopHost | undefined;
  let session: AppSession | undefined;
  try {
    host = await startDesktopHost(fixture, { reseed: options.reseed });
    const connected = await connectSession(fixture, wire);
    session = connected.session;
    const runningHost = host;
    const runningSession = session;
    return {
      fixture,
      host: runningHost,
      session: runningSession,
      api: connected.api,
      runtime: connected.runtime,
      wire,
      async dispose() {
        runningSession.dispose();
        await runningHost.stop();
        await fixture.relay.stop();
        rmSync(fixture.tempDir, { recursive: true, force: true });
      }
    };
  } catch (error) {
    session?.dispose();
    await host?.stop().catch(() => undefined);
    await fixture.relay.stop();
    rmSync(fixture.tempDir, { recursive: true, force: true });
    throw error;
  }
}

/** Waits until the restarted desktop host is reachable again through the Relay. */
async function waitForHostReachable(threeEnd: ThreeEnd): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const result = await threeEnd.session.connection.reads.hostStatus();
    if (result.ok) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `the restarted desktop host never became reachable: ${result.error.code} ${result.error.message}`
      );
    }
    await delay(100);
  }
}

describe("three-end acceptance: mini program against a real Relay and a real desktop host", () => {
  after(() => {
    cleanupRelayBuild();
  });

  test(
    "home, conversations and chat render the desktop's own data, with host-side paging",
    { skip: SKIP, timeout: 180_000 },
    async () => {
      const threeEnd = await provision({ reseed: true });
      try {
        const { session, runtime, wire, fixture } = threeEnd;
        const connection = session.connection;

        // The cold start must have taken exactly one authoritative snapshot and no resume.
        assert.equal(rpcRequests(wire.sent, "sync.snapshot").length, 1);
        assert.equal(framesOfType(wire.sent, "resume").length, 0);
        assert.equal(wire.socketUrls.length, 1, "one App session owns exactly one socket");
        assert.equal(wire.socketUrls[0], `${relayWsBaseUrl(fixture)}/v1/ws/admin`);

        /* -------- home: the real host's own status -------------------------------- */
        const homeRenders: HomePageData[] = [];
        const home = createHomeController({
          connection,
          dev: session.dev,
          auth: session.auth,
          runtime,
          environmentName: "local",
          setData: (data) => homeRenders.push(data)
        });
        home.start();
        const homeData = await waitFor(
          () => {
            const data = homeRenders.at(-1);
            return data !== undefined && data.hasHost && data.metrics.length === 5 ? data : null;
          },
          15_000,
          "the home page to render the real host status"
        );

        assert.equal(homeData.hostStatusError, null, "host.status must succeed against the real host");
        assert.equal(homeData.hostTitle, HOST_DISPLAY_NAME);
        assert.match(homeData.hostSubtitle, /在线/);
        assert.match(homeData.hostSubtitle, /协议 v1/);
        assert.equal(homeData.remoteEnabled, true);
        assert.equal(homeData.hasPendingDecisions, false);
        const metric = (label: string): string | undefined =>
          homeData.metrics.find((entry) => entry.label === label)?.value;
        assert.equal(metric("运行中"), String(ACTIVE_RUN_COUNT));
        assert.equal(metric("待决策"), "0");
        assert.equal(metric("项目"), "1");
        assert.equal(homeData.projects.length, 1);
        assert.equal(homeData.projects[0].title, fixture.seed.project.name);
        assert.equal(homeData.isDevConnection, true, "a DEV connection must never look like a WeChat login");
        assert.match(homeData.credentialNotice, /DEV/);

        home.openConversations();
        assert.deepEqual(runtime.navigations, [ROUTES.conversations]);

        /* -------- conversations: real rows, paged by the real dispatcher ---------- */
        const conversationPages: ConversationsPageData[] = [];
        const conversations = createConversationsController({
          connection,
          runtime,
          setData: (data) => conversationPages.push(data)
        });
        conversations.start();

        const firstPage = await waitFor(
          () => {
            const data = conversationPages.at(-1);
            return data !== undefined && data.cursor === String(CONVERSATION_PAGE) ? data : null;
          },
          15_000,
          "the first conversation page"
        );
        assert.equal(firstPage.items.length, CONVERSATION_PAGE);
        assert.equal(firstPage.hasMore, true);
        assert.equal(firstPage.loadMoreEnabled, true);
        assert.equal(firstPage.empty, false);
        assert.equal(firstPage.error, null);
        assert.equal(firstPage.truncated, false);
        // Newest first, and the titles/ids are the ones the desktop's database holds.
        assert.deepEqual(
          firstPage.items.slice(0, 3).map((item) => [item.id, item.title]),
          [
            [conversationId(0), conversationTitle(0)],
            [conversationId(1), conversationTitle(1)],
            [conversationId(2), conversationTitle(2)]
          ]
        );
        assert.equal(firstPage.items[CONVERSATION_PAGE - 1].id, conversationId(CONVERSATION_PAGE - 1));

        conversations.loadMore();
        const secondPage = await waitFor(
          () => {
            const data = conversationPages.at(-1);
            return data !== undefined && data.items.length === CONVERSATION_COUNT ? data : null;
          },
          15_000,
          "the second conversation page"
        );
        assert.equal(secondPage.hasMore, false);
        assert.equal(secondPage.cursor, null);
        assert.equal(secondPage.loadMoreEnabled, false);
        assert.equal(secondPage.items[CONVERSATION_PAGE].id, conversationId(CONVERSATION_PAGE));
        assert.equal(secondPage.items[CONVERSATION_COUNT - 1].id, conversationId(CONVERSATION_COUNT - 1));
        assert.equal(
          new Set(secondPage.items.map((item) => item.id)).size,
          CONVERSATION_COUNT,
          "no page may be merged twice"
        );

        const listRequests = rpcRequests(wire.sent, "conversation.list");
        assert.equal(listRequests.length, 2);
        assert.deepEqual(paramsOf(listRequests[0]), { limit: CONVERSATION_PAGE });
        assert.deepEqual(paramsOf(listRequests[1]), {
          cursor: String(CONVERSATION_PAGE),
          limit: CONVERSATION_PAGE
        });

        /* -------- chat: real messages, paged by the real dispatcher --------------- */
        const chatPages: ChatPageData[] = [];
        const chat = createChatController({
          connection,
          runtime,
          conversationId: TARGET_CONVERSATION,
          setData: (data) => chatPages.push(data)
        });
        chat.start();
        const newestWindow = await waitFor(
          () => {
            const data = chatPages.at(-1);
            return data !== undefined && data.messages.length === CONVERSATION_PAGE ? data : null;
          },
          15_000,
          "the first message window"
        );
        assert.equal(newestWindow.title, conversationTitle(TARGET_CONVERSATION_INDEX));
        assert.equal(newestWindow.hasMore, true);
        assert.equal(newestWindow.loadOlderEnabled, true);
        assert.equal(newestWindow.empty, false);
        assert.equal(newestWindow.error, null);
        assert.equal(newestWindow.canSend, false, "the read-only stage must not offer a send path");
        assert.match(newestWindow.readonlyNotice, /只读/);
        assert.deepEqual(
          newestWindow.messages.slice(0, 2).map((message) => [
            message.id,
            message.text,
            message.roleLabel
          ]),
          [
            [messageId(0), messageContent(0), "我"],
            [messageId(1), messageContent(1), "助手"]
          ]
        );
        assert.equal(
          newestWindow.messages[CONVERSATION_PAGE - 1].id,
          messageId(CONVERSATION_PAGE - 1)
        );

        chat.loadOlder();
        const fullThread = await waitFor(
          () => {
            const data = chatPages.at(-1);
            return data !== undefined && data.messages.length === MESSAGE_COUNT ? data : null;
          },
          15_000,
          "the older message page"
        );
        assert.equal(fullThread.hasMore, false);
        assert.equal(fullThread.loadedOlder, true);
        assert.equal(fullThread.messages[MESSAGE_COUNT - 1].id, messageId(MESSAGE_COUNT - 1));
        assert.equal(fullThread.messages[MESSAGE_COUNT - 1].text, messageContent(MESSAGE_COUNT - 1));
        assert.equal(
          fullThread.messages.map((message) => message.id).join(","),
          Array.from({ length: MESSAGE_COUNT }, (_unused, index) => messageId(index)).join(","),
          "messages must render once, in host order"
        );

        // A second conversation must not see the first one's messages.
        const otherPages: ChatPageData[] = [];
        const otherChat = createChatController({
          connection,
          runtime,
          conversationId: OTHER_CONVERSATION,
          setData: (data) => otherPages.push(data)
        });
        otherChat.start();
        const otherThread = await waitFor(
          () => {
            const data = otherPages.at(-1);
            return data !== undefined && data.messages.length === OTHER_MESSAGE_COUNT ? data : null;
          },
          15_000,
          "the other conversation's messages"
        );
        assert.deepEqual(
          otherThread.messages.map((message) => message.text),
          ["other 00", "other 01", "other 02"]
        );
        assert.equal(otherThread.hasMore, false);

        otherChat.stop();
        chat.stop();
        conversations.stop();
        home.stop();
      } finally {
        await threeEnd.dispose();
      }
    }
  );

  test(
    "live desktop updates reach the pages, a reconnect resumes, and a restarted host forces a snapshot",
    { skip: SKIP, timeout: 180_000 },
    async () => {
      const threeEnd = await provision({ reseed: true });
      let restarted: DesktopHost | undefined;
      try {
        const { session, runtime, wire, fixture, host } = threeEnd;
        const connection = session.connection;
        const hostId = fixture.hostId;

        const conversationPages: ConversationsPageData[] = [];
        const conversations = createConversationsController({
          connection,
          runtime,
          setData: (data) => conversationPages.push(data)
        });
        conversations.start();
        await waitFor(
          () => {
            const data = conversationPages.at(-1);
            return data !== undefined && data.cursor === String(CONVERSATION_PAGE) ? true : null;
          },
          15_000,
          "the conversation list to be loaded"
        );

        /** The baseline the desktop reported for its own snapshot, read off the wire. */
        const snapshotBaseSeq = (): number => {
          // `sync.snapshot`'s result is the only `rpc.response` that carries a `baseSeq`; the
          // request itself is on `wire.sent` and the response on `wire.received`.
          const frame = framesOfType(wire.received, "rpc.response").find((candidate) => {
            const payload = candidate.payload as { result?: { baseSeq?: unknown } } | undefined;
            return typeof payload?.result?.baseSeq === "number";
          });
          assert.ok(frame, "the app must have received sync.snapshot's result");
          return (frame.payload as { result: { baseSeq: number } }).result.baseSeq;
        };
        const baseSeq = snapshotBaseSeq();

        /* ---- live updates: the desktop mutates its store and publishes --------- */
        const firstTitle = "Renamed by the owner";
        const finalTitle = "Renamed once more";
        await host.command({
          type: "rename_conversation",
          conversationId: conversationId(RENAMED_CONVERSATION_INDEX),
          title: firstTitle,
          updatedAt: new Date(SEED_EPOCH_MS + 600_000).toISOString()
        });
        await host.command({
          type: "rename_conversation",
          conversationId: conversationId(RENAMED_CONVERSATION_INDEX),
          title: finalTitle,
          updatedAt: new Date(SEED_EPOCH_MS + 660_000).toISOString()
        });

        const titleOf = (id: string): string | undefined =>
          conversationPages.at(-1)?.items.find((item) => item.id === id)?.title;
        await waitFor(
          () => (titleOf(conversationId(RENAMED_CONVERSATION_INDEX)) === finalTitle ? true : null),
          15_000,
          "the renamed conversation to arrive as a live event"
        );

        // Both updates were put on the wire by the real host; the page shows the newest one.
        const deliveredEvents = framesOfType(wire.received, "event");
        assert.ok(
          deliveredEvents.length >= 2,
          `both host updates must cross the Relay (received ${deliveredEvents.length})`
        );
        const lastSeq = connection.resume.state(hostId).lastSeq;
        assert.ok(typeof lastSeq === "number" && lastSeq > baseSeq);
        assert.equal(connection.getSnapshot().violations, 0);

        /* ---- reconnect: resume from the cursor, not another snapshot ------------ */
        const sentBeforeReconnect = wire.sent.length;
        connection.close("three-end reconnect");
        connection.connect("three-end reconnect");
        await waitFor(
          () => (connection.getSnapshot().status === "online" ? true : null),
          15_000,
          "the admin socket to come back"
        );
        await delay(300);
        const reconnectsSent = wire.sent.slice(sentBeforeReconnect);
        assert.equal(
          framesOfType(reconnectsSent, "resume").length,
          1,
          "a reconnect must resume with the last completely applied seq"
        );
        assert.equal(
          rpcRequests(reconnectsSent, "sync.snapshot").length,
          0,
          "a usable cursor must not trigger another full snapshot"
        );
        assert.equal(titleOf(conversationId(RENAMED_CONVERSATION_INDEX)), finalTitle);

        /* ---- the desktop quits: reads fail loudly, the cache is kept ------------ */
        await host.stop();
        await waitFor(
          () => (connection.getSnapshot().status === "online" ? true : null),
          5_000,
          "the admin socket to stay up while the desktop is gone"
        );
        // What the operator is looking at when the host disappears: the one page the list loaded.
        const loadedBeforeFailure = conversationPages.at(-1)?.items.length ?? 0;
        assert.equal(loadedBeforeFailure, CONVERSATION_PAGE);

        conversations.refresh();
        const offlinePage = await waitFor(
          () => {
            const data = conversationPages.at(-1);
            return data !== undefined && data.error !== null ? data : null;
          },
          15_000,
          "the offline read to surface the Relay's host_offline error"
        );
        assert.match(offlinePage.error ?? "", /主机离线/);
        assert.equal(
          offlinePage.items.length,
          loadedBeforeFailure,
          "a failed read must not wipe the cache the operator is looking at"
        );

        /* ---- the desktop restarts: the stale cursor forces the snapshot --------- */
        restarted = await startDesktopHost(fixture, { reseed: false });
        await waitForHostReachable(threeEnd);

        const snapshotsBeforeRestart = framesOfType(wire.received, "snapshot").length;
        connection.close("desktop restarted");
        connection.connect("desktop restarted");
        await waitFor(
          () => (connection.getSnapshot().status === "online" ? true : null),
          15_000,
          "the admin socket to come back after the desktop restart"
        );
        await waitFor(
          () => {
            const state = connection.resume.state(hostId);
            return state.materialized && state.lastSeq === 0 ? true : null;
          },
          15_000,
          "the restarted host's authoritative snapshot to replace the cache"
        );

        const snapshotFrames = framesOfType(wire.received, "snapshot");
        assert.equal(
          snapshotFrames.length,
          snapshotsBeforeRestart + 1,
          "a cursor from the previous host generation must fall back to a snapshot frame"
        );
        assert.equal(connection.stores.host.getState().baseSeq, 0);
        assert.equal(connection.resume.state(hostId).baseSeq, 0);
        assert.equal(
          conversationPages.at(-1)?.items.length,
          SNAPSHOT_CONVERSATION_WINDOW,
          "the replacement snapshot must carry the desktop's real rows, bounded by its own window"
        );
        // A live `conversation.updated` merges in place, so before the snapshot the head of the
        // list was still row 0. The snapshot replaces the whole list with the *desktop's* order
        // and window, in which the renamed conversation is now first — the head can only move
        // because the rows came back from the desktop's database.
        assert.deepEqual(
          conversationPages.at(-1)?.items.map((item) => item.id),
          expectedSnapshotOrderAfterRenames().slice(0, SNAPSHOT_CONVERSATION_WINDOW),
          "the snapshot's rows and their order must be the desktop's, not the leftover page's"
        );
        assert.equal(
          conversationPages.at(-1)?.items[0]?.id,
          conversationId(RENAMED_CONVERSATION_INDEX),
          "the snapshot's first row must be the desktop's newest, not a leftover page"
        );
        assert.equal(
          titleOf(conversationId(RENAMED_CONVERSATION_INDEX)),
          finalTitle,
          "the snapshot must come from the desktop's own database, not from the client cache"
        );

        conversations.stop();
      } finally {
        await restarted?.stop().catch(() => undefined);
        await threeEnd.dispose();
      }
    }
  );

  test(
    "an unloaded page stops rendering while App state survives, and sign-out leaves nothing behind",
    { skip: SKIP, timeout: 180_000 },
    async () => {
      const threeEnd = await provision({ reseed: true });
      try {
        const { session, runtime, wire, fixture, api } = threeEnd;
        const connection = session.connection;
        const hostId = fixture.hostId;

        const conversationPages: ConversationsPageData[] = [];
        const conversations = createConversationsController({
          connection,
          runtime,
          setData: (data) => conversationPages.push(data)
        });
        conversations.start();
        await waitFor(
          () => {
            const data = conversationPages.at(-1);
            return data !== undefined && data.cursor === String(CONVERSATION_PAGE) ? true : null;
          },
          15_000,
          "the conversation list to be loaded"
        );

        const homeRenders: HomePageData[] = [];
        const home = createHomeController({
          connection,
          dev: session.dev,
          auth: session.auth,
          runtime,
          environmentName: "local",
          setData: (data) => homeRenders.push(data)
        });
        home.start();
        await waitFor(
          () => (homeRenders.at(-1)?.hasHost === true ? true : null),
          15_000,
          "the home page to render"
        );

        // The operator navigates away: the page unsubscribes and must never touch `setData` again.
        home.stop();
        conversations.stop();
        const rendersAfterUnload = conversationPages.length + homeRenders.length;

        // Recovery state belongs to the App, so it keeps working with no page attached.
        await connection.state.loadConversations(false);
        await delay(200);
        assert.equal(
          connection.stores.conversations.getState().items.length,
          CONVERSATION_COUNT,
          "the App-owned cache must keep paging after the page unloaded"
        );
        assert.equal(
          conversationPages.length + homeRenders.length,
          rendersAfterUnload,
          "an unloaded page must not receive another render"
        );

        // The cursor the operator earned is persisted before sign-out. It is the *only* thing
        // this client is allowed to persist, so the record is inspected directly: it must hold
        // this host's numbers and nothing else — no token, no title, no message text.
        assert.ok(wire.sent.length > 0, "the session must have used the wire by now");
        const persisted = api.storage.get(RESUME_CURSOR_STORAGE_KEY);
        assert.ok(persisted !== undefined, "the resume cursor must be persisted while the session is live");
        assert.deepEqual(
          Object.keys(persisted as Record<string, unknown>),
          [hostId],
          "only the connected host may have a persisted cursor"
        );
        const persistedRecord = (persisted as Record<string, Record<string, unknown>>)[hostId];
        assert.equal(typeof persistedRecord.baseSeq, "number");
        assert.equal(typeof persistedRecord.lastSeq, "number");
        assert.ok(
          (persistedRecord.lastSeq as number) >= (persistedRecord.baseSeq as number),
          "the cursor must not sit below the snapshot baseline it describes"
        );
        const persistedText = JSON.stringify([...api.storage.entries()]);
        assert.ok(
          !persistedText.includes(fixture.relay.adminToken),
          "never persist the DEV credential"
        );
        assert.ok(
          !persistedText.includes(conversationTitle(0)) && !persistedText.includes(messageContent(0)),
          "never persist conversation or message content"
        );

        // The same rule has to hold for the artifacts a crash report or a screenshot would
        // capture: the Relay is running with `LOG_LEVEL=debug` and the desktop host writes its
        // transcript to stdout, so both are checked while both are still alive. Their output is
        // held in this process's memory only — neither harness writes a log file.
        for (const secret of [fixture.relay.adminToken, fixture.relay.hostToken]) {
          assert.ok(!fixture.relay.logs().includes(secret), "the Relay must never log a DEV credential");
          assert.ok(
            !threeEnd.host.stdout.join("\n").includes(secret),
            "the desktop host must never print a DEV credential"
          );
        }

        /* ---- sign-out: everything goes ------------------------------------------ */
        session.dev.signOut();
        assert.equal(connection.getSnapshot().status, "signedOut");
        assert.equal(connection.hasToken(), false);
        assert.equal(connection.getHostId(), null);
        assert.equal(
          session.dev.getState().hasToken,
          false,
          "the DEV controller must not still report a credential"
        );

        // No cache survives: neither the entity stores nor the recovery cursor they backed.
        assert.equal(connection.stores.conversations.getState().items.length, 0);
        assert.equal(connection.stores.host.getState().host, null);
        assert.equal(connection.resume.states().length, 0, "no cursor may outlive the sign-out");
        assert.equal(
          api.storage.has(RESUME_CURSOR_STORAGE_KEY),
          false,
          "the persisted cursor must be removed on sign-out"
        );
        assert.ok(
          !JSON.stringify([...api.storage.entries()]).includes(fixture.relay.adminToken),
          "no credential material may be left in storage"
        );

        // Isolation also covers transport: the socket is gone and nothing reconnects it.
        assert.equal(wire.socketUrls.length, 1);
        await delay(200);
        assert.equal(wire.socketUrls.length, 1, "a signed-out session must not reconnect");
      } finally {
        await threeEnd.dispose();
      }
    }
  );
});
