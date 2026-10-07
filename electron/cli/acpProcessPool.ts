import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { AcpStdioMcpServer } from "../shared/browserToolProtocol.js";

export interface AcpWarmConnection {
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  fingerprint: string;
  conversationId: string;
  initialize?: any;
  requestId: number;
  sessionId?: string;
  previousRunId?: string;
  browserServer?: AcpStdioMcpServer;
  dispose: () => void;
}

/** Idle connections only; active turns remain owned by the existing run lifecycle. */
export class AcpProcessPool {
  private idle = new Map<string, { connection: AcpWarmConnection; timer: ReturnType<typeof setTimeout>; close: () => void }>();
  constructor(private ttlMs = 10 * 60_000, private limit = 4) {}

  take(key: string, fingerprint: string, sessionId?: string): AcpWarmConnection | undefined {
    const entry = this.idle.get(key);
    if (!entry) return;
    this.remove(key);
    const c = entry.connection;
    if (c.fingerprint !== fingerprint || !sessionId || c.sessionId !== sessionId ||
        c.child.exitCode !== null || c.child.signalCode !== null || c.child.stdin.destroyed || c.child.stdin.writableEnded) {
      c.dispose();
      return;
    }
    return c;
  }

  put(key: string, connection: AcpWarmConnection): void {
    this.discard(key);
    if (connection.child.exitCode !== null || connection.child.signalCode !== null || connection.child.stdin.destroyed) {
      connection.dispose(); return;
    }
    const close = () => this.discard(key);
    const timer = setTimeout(close, this.ttlMs);
    timer.unref();
    this.idle.set(key, { connection, timer, close });
    connection.child.once("close", close);
    connection.child.once("error", close);
    // Drain late diagnostics while idle; no completed run receives new events.
    connection.child.stdout.resume();
    connection.child.stderr.resume();
    while (this.idle.size > this.limit) this.discard(this.idle.keys().next().value!);
  }

  discard(key: string): void {
    const entry = this.remove(key);
    entry?.connection.dispose();
  }

  closeConversation(conversationId: string): void {
    for (const [key, { connection }] of this.idle) if (connection.conversationId === conversationId) this.discard(key);
  }

  dispose(): void { for (const key of this.idle.keys()) this.discard(key); }

  private remove(key: string) {
    const entry = this.idle.get(key);
    if (!entry) return;
    this.idle.delete(key);
    clearTimeout(entry.timer);
    entry.connection.child.off("close", entry.close);
    entry.connection.child.off("error", entry.close);
    return entry;
  }
}

export const acpProcessPool = new AcpProcessPool();
