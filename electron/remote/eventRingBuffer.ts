import { randomBytes } from "node:crypto";
import { MAX_CHUNK_BYTES, REMOTE_PROTOCOL_VERSION, type EventFrame, type RemoteEventName } from "@freebuddy/protocol/remote";

export interface RemoteEventInput { name: RemoteEventName; data: Record<string, unknown>; }

/** Local-only bounded replay state. Payloads are never written to Relay or disk. */
export class EventRingBuffer {
  private entries: Array<EventFrame> = [];
  private nextSeq = 0;
  constructor(private readonly hostId: string, private readonly maxEntries = 2048, private readonly maxAgeMs = 600_000, private readonly now: () => number = Date.now) {}
  publish(input: RemoteEventInput): EventFrame[] {
    const text = JSON.stringify(input.data);
    // v1 event variants do not carry a generic chunk envelope. Oversized
    // domain updates are omitted; the next resume receives a full snapshot.
    if (Buffer.byteLength(text) > MAX_CHUNK_BYTES) return [];
    const chunks = [input.data];
    const frames = chunks.map(data => ({ v: REMOTE_PROTOCOL_VERSION, type: "event" as const, id: `msg_${randomBytes(12).toString("base64url")}`, hostId: this.hostId, sentAt: new Date(this.now()).toISOString(), seq: this.nextSeq++, payload: { name: input.name, data } } as unknown as EventFrame));
    this.entries.push(...frames); this.prune(); return frames;
  }
  resume(afterSeq: number): EventFrame[] | null {
    this.prune();
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) return null;
    // A client cursor from a future host epoch cannot be replayed safely.
    if (afterSeq >= this.nextSeq) return null;
    if (this.entries.length === 0) return afterSeq === this.nextSeq - 1 ? [] : null;
    if (afterSeq < this.entries[0].seq - 1) return null;
    return this.entries.filter(entry => entry.seq > afterSeq);
  }
  baseSeq(): number { this.prune(); return this.nextSeq; }
  private prune(): void { const cutoff = this.now() - this.maxAgeMs; while (this.entries.length > this.maxEntries || (this.entries[0] && Date.parse(this.entries[0].sentAt) < cutoff)) this.entries.shift(); }
}
