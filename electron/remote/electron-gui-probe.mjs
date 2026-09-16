import { app, BrowserWindow } from "electron";

const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);

// Keep the entry module synchronous: Electron can only resolve readiness after
// evaluating it, so top-level await here can obscure an entry/ready deadlock.
write({ type: "stage", stage: "module_loaded" });
app.whenReady().then(async () => {
  write({ type: "stage", stage: "ready" });
  const window = new BrowserWindow({ show: true, width: 64, height: 64 });
  write({ type: "stage", stage: "window_created" });
  await window.loadURL("data:text/html,<title>FreeBuddy GUI probe</title>");
  write({ type: "gui_ready" });
  window.destroy();
  app.exit(0);
}).catch(error => {
  write({ type: "error", stage: "ready_or_window", message: error instanceof Error ? error.message : "GUI probe failed" });
  app.exit(1);
});
