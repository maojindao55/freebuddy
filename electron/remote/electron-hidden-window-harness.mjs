import readline from "node:readline";
import { app, BrowserWindow, safeStorage } from "electron";

const required = ["FB_REMOTE_TEST_USER_DATA", "FB_REMOTE_DEV_ENDPOINT", "FB_REMOTE_DEV_HOST_TOKEN", "FB_REMOTE_DEV_HOST_ID"];
if (required.some(key => !process.env[key])) throw new Error("missing required remote Electron test configuration");
app.setPath("userData", process.env.FB_REMOTE_TEST_USER_DATA);
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let window; let remote;
function stop(code = 0) { remote?.disable(); remote = undefined; if (window && !window.isDestroyed()) window.destroy(); app.exit(code); }
// Keep entry evaluation independent of Electron readiness; `app.setPath` above
// remains before ready as Electron requires.
write({ type: "stage", stage: "module_loaded" });
app.whenReady().then(async () => {
  write({ type: "stage", stage: "ready" });
  try {
  // Import after readiness so this uses actual Electron safeStorage, not Node mode.
  write({ type: "stage", stage: "imports_start" });
  const [{ startReadOnlyRemoteDevelopment }, { getDb }, { createUser }, { createProject }, { createConversation }, { broadcastEvent }] = await Promise.all([
    import("../../dist-electron/remote/localDevelopment.js"), import("../../dist-electron/cli/db.js"), import("../../dist-electron/cli/users.js"), import("../../dist-electron/cli/projects.js"), import("../../dist-electron/cli/conversations.js"), import("../../dist-electron/eventBus.js")
  ]);
  write({ type: "stage", stage: "imports_complete" });
  getDb();
  write({ type: "stage", stage: "database_ready" });
  const { user } = createUser({ username: "remote-electron-owner", password: "password123", isOwner: true });
  const project = createProject({ name: "Remote Electron test", folders: [process.env.FB_REMOTE_TEST_USER_DATA], primaryPath: process.env.FB_REMOTE_TEST_USER_DATA });
  createConversation({ id: "conv_electron_hidden", title: "Hidden Electron", agentId: "agent_electron", agentName: "Electron Agent", adapter: "codex", projectId: project.id, ownerId: user.id });
  write({ type: "stage", stage: "store_seeded" });
  window = new BrowserWindow({ show: true, width: 320, height: 240, webPreferences: { contextIsolation: true, sandbox: true } });
  write({ type: "stage", stage: "window_created" });
  await window.loadURL("data:text/html,<title>FreeBuddy remote M3 test</title>");
  write({ type: "stage", stage: "window_loaded" });
  write({ type: "stage", stage: "safe_storage_checking" });
  if (!safeStorage.isEncryptionAvailable()) throw new Error("OS credential encryption is unavailable");
  write({ type: "stage", stage: "safe_storage_available" });
  const encryptedSafeStorageProbe = safeStorage.encryptString("freebuddy-m3-safe-storage-probe");
  write({ type: "stage", stage: "safe_storage_encrypted" });
  const safeStorageProbe = safeStorage.decryptString(encryptedSafeStorageProbe);
  if (safeStorageProbe !== "freebuddy-m3-safe-storage-probe") throw new Error("OS credential encryption round trip failed");
  write({ type: "stage", stage: "safe_storage_ready" });
  write({ type: "stage", stage: "remote_starting" });
  remote = startReadOnlyRemoteDevelopment({ isPackaged: app.isPackaged });
  write({ type: "stage", stage: "remote_started" });
  if (!remote) throw new Error("explicit read-only development entry point did not start");
  write({ type: "ready", visible: window.isVisible() });
  const commands = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  commands.on("line", line => { try {
    const command = JSON.parse(line);
    if (command.type === "hide") { window.hide(); write({ type: "hidden", visible: window.isVisible() }); return; }
    if (command.type === "event") { broadcastEvent("conversations://changed", { conversationId: "conv_electron_hidden" }); write({ type: "event-published" }); return; }
    if (command.type === "stop") { stop(); return; }
    throw new Error("unknown command");
  } catch (error) { write({ type: "error", message: error instanceof Error ? error.message : "invalid command" }); } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "remote Electron harness failed";
    write({ type: /credential encryption|safeStorage/i.test(message) ? "blocked_safe_storage" : "error", message }); stop(1);
  }
}).catch(error => {
  write({ type: "error", stage: "ready", message: error instanceof Error ? error.message : "Electron readiness failed" });
  stop(1);
});
