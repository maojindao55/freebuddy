import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { utilityProcess } from "electron";
import { SNAPSHOT_BATCH_ENTRIES, type SnapshotScanEvent, type SnapshotScanRequest } from "./turnFileSnapshotScan.js";

export interface SnapshotProcess {
  send(message: unknown): void;
  onMessage(handler: (message: any) => void): () => void;
  onExit(handler: (code: number | null) => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  kill(): void;
  ref?(): void;
  unref?(): void;
}

function launchSnapshotProcess(): SnapshotProcess {
  const entry = fileURLToPath(new URL("./turnFileSnapshotWorker.js", import.meta.url));
  if (process.type === "browser") {
    const child = utilityProcess.fork(entry, [], { serviceName: "freebuddy-file-snapshots", stdio: "ignore" });
    return {
      send: message => child.postMessage(message),
      onMessage(handler) { child.on("message", handler); return () => child.off("message", handler); },
      onExit(handler) { child.on("exit", handler); return () => child.off("exit", handler); },
      onError(handler) {
        const listener = (type: string, location: string) => handler(new Error(`${type}: ${location}`));
        child.on("error", listener); return () => child.off("error", listener);
      },
      kill() { child.kill(); }
    };
  }
  // Node/Electron-as-Node test runners use the identical worker and protocol.
  const child = fork(entry, [], { stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", execArgv: [] });
  return {
    send(message) { child.send(message as never); },
    onMessage(handler) { child.on("message", handler); return () => child.off("message", handler); },
    onExit(handler) { child.on("exit", handler); return () => child.off("exit", handler); },
    onError(handler) { child.on("error", handler); return () => child.off("error", handler); },
    kill() { child.kill(); },
    ref() { child.ref(); child.channel?.ref(); },
    unref() { child.unref(); child.channel?.unref(); }
  };
}

/** Reuses one capture process; jobs are queued and bodies arrive with backpressure. */
export class SnapshotScanClient {
  private worker?: { process: SnapshotProcess; ready: boolean; removeExit: () => void; removeError: () => void };
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private launch = launchSnapshotProcess, private timeoutGraceMs = 5000) {}

  run(request: SnapshotScanRequest, consume: (event: SnapshotScanEvent) => void | Promise<void>): Promise<boolean> {
    const result = this.queue.then(() => {
      if (this.disposed) throw new Error("File capture process is shutting down");
      return this.execute(request, consume);
    });
    this.queue = result.catch(() => {});
    return result;
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    const worker = this.worker;
    this.worker = undefined;
    if (worker) worker.process.kill();
  }

  dispose(): void { this.disposed = true; this.stop(); }

  private execute(request: SnapshotScanRequest, consume: (event: SnapshotScanEvent) => void | Promise<void>): Promise<boolean> {
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      const process = this.launch();
      const worker = { process, ready: false, removeExit: () => {}, removeError: () => {} };
      worker.removeExit = process.onExit(() => {
        if (this.worker === worker) this.worker = undefined;
        worker.removeExit(); worker.removeError();
      });
      // Keep an error listener while idle as well as during requests.
      worker.removeError = process.onError(() => {});
      this.worker = worker;
    }
    const worker = this.worker;
    worker.process.ref?.();
    const id = ++this.sequence;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false, started = false, consuming = false;
      const cleanup = () => { clearTimeout(timer); removeMessage(); removeExit(); removeError(); };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; cleanup(); this.stop(); reject(error);
      };
      const start = () => {
        if (started || settled) return;
        started = true;
        try { worker.process.send({ kind: "scan", id, request }); }
        catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      };
      const removeMessage = worker.process.onMessage(message => {
        if (settled || !message || typeof message !== "object") return;
        if (message.kind === "ready") { worker.ready = true; start(); return; }
        if (message.id !== id) return;
        if (message.kind === "error") { fail(new Error(String(message.error))); return; }
        if (message.kind === "done") {
          if (consuming || typeof message.complete !== "boolean") { fail(new Error("Invalid file capture result")); return; }
          settled = true; cleanup(); worker.process.unref?.();
          this.idleTimer = setTimeout(() => this.stop(), 30_000);
          this.idleTimer.unref();
          resolve(message.complete);
          return;
        }
        if (message.kind !== "roots" && message.kind !== "batch") { fail(new Error("Invalid file capture event")); return; }
        const valid = message.kind === "roots"
          ? Array.isArray(message.roots) && message.roots.every((root: any) => root && typeof root.path === "string" && typeof root.complete === "boolean")
          : Array.isArray(message.entries) && message.entries.length <= SNAPSHOT_BATCH_ENTRIES && message.entries.every((entry: any) =>
            entry && typeof entry.path === "string" && typeof entry.identity === "string" && entry.before &&
            (entry.body === undefined || entry.body instanceof Uint8Array && entry.body.byteLength <= request.limits.fileBytes));
        if (consuming || !valid) { fail(new Error("Invalid file capture batch")); return; }
        consuming = true;
        // Return to the event loop between batches, then acknowledge persistence.
        void new Promise<void>(ready => setImmediate(ready)).then(() => {
          if (!settled) return consume(message);
        }).then(() => {
          if (!settled) { consuming = false; worker.process.send({ kind: "ack", id }); }
        }).catch(error => fail(error instanceof Error ? error : new Error(String(error))));
      });
      const removeExit = worker.process.onExit(code => fail(new Error(`File capture process exited (${code})`)));
      const removeError = worker.process.onError(fail);
      const timer = setTimeout(() => fail(new Error("File capture process timed out")), Math.max(0, request.limits.milliseconds) + this.timeoutGraceMs);
      if (worker.ready) start();
    });
  }
}

const client = new SnapshotScanClient();
export const scanSnapshots = (request: SnapshotScanRequest, consume: (event: SnapshotScanEvent) => void | Promise<void>) => client.run(request, consume);
export const stopSnapshotProcess = () => client.dispose();
