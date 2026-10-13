import type { ParentPort } from "electron";
import { scanSnapshotVersions, type SnapshotScanEvent, type SnapshotScanRequest } from "./turnFileSnapshotScan.js";

const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
const send = (message: unknown) => {
  if (port) port.postMessage(message);
  else if (process.send) process.send(message as never);
  else throw new Error("File capture process has no parent transport");
};
let current: { id: number; acknowledge?: () => void } | undefined;

function receive(message: any): void {
  if (!message || typeof message !== "object") return;
  if (message.kind === "ack" && current && current.id === message.id) {
    const acknowledge = current.acknowledge;
    current.acknowledge = undefined;
    acknowledge?.();
    return;
  }
  if (message.kind !== "scan" || !Number.isSafeInteger(message.id)) return;
  if (current) { send({ kind: "error", id: message.id, error: "File capture process is busy" }); return; }
  const job = { id: message.id, acknowledge: undefined as (() => void) | undefined };
  current = job;
  const publish = (event: SnapshotScanEvent) => new Promise<void>(resolve => {
    job.acknowledge = resolve;
    send({ ...event, id: job.id });
  });
  void scanSnapshotVersions(message.request as SnapshotScanRequest, publish).then(complete => {
    current = undefined;
    send({ kind: "done", id: job.id, complete });
  }, error => {
    current = undefined;
    send({ kind: "error", id: job.id, error: String(error) });
  });
}

if (port) port.on("message", event => receive(event.data));
else {
  process.on("message", receive);
  process.on("disconnect", () => process.exit(0));
}
send({ kind: "ready", pid: process.pid });
