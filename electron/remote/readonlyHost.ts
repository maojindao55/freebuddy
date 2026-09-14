import type { RemoteFrame } from "@freebuddy/protocol/remote";
import { subscribeEventBroadcaster } from "../eventBus.js";
import type { RelayClient } from "./relayClient.js";
import { AdminDispatcher } from "./adminDispatcher.js";
import { EventRingBuffer, type RemoteEventInput } from "./eventRingBuffer.js";
import { SnapshotService, type HostStatusSource } from "./snapshotService.js";

const eventNames: Record<string, RemoteEventInput["name"]> = {
  "conversations://changed": "conversation.updated", "messages://changed": "message.updated",
  "tasks://changed": "task.updated", "workflows://changed": "workflow.updated",
  "delegation://finished": "delegation.updated"
};
function mapEvent(channel: string, payload: unknown, snapshots: SnapshotService): RemoteEventInput | undefined {
  const name = eventNames[channel];
  if (!name) return undefined;
  // Do not forward arbitrary internal payloads. Only stable IDs are allowed.
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  if (name === "conversation.updated" && typeof record.conversationId === "string") { const item = snapshots.conversation(record.conversationId); return item ? { name, data: item } : undefined; }
  if (name === "message.updated" && typeof record.conversationId === "string") { const item = snapshots.messages(record.conversationId).at(-1); return item ? { name, data: item } : undefined; }
  if (name === "task.updated" && typeof record.taskId === "string") { const item = snapshots.tasks().find(x => x.taskId === record.taskId); return item ? { name, data: item } : undefined; }
  if (name === "workflow.updated" && typeof record.workflowId === "string") { const item = snapshots.workflows().find(x => x.workflowId === record.workflowId); return item ? { name, data: item } : undefined; }
  if (name === "delegation.updated" && typeof record.delegationId === "string") { const item = snapshots.delegation(record.delegationId); return item ? { name, data: item } : undefined; }
  return undefined;
}

/** Explicit opt-in D4 bridge. Call only after the user enables Remote in settings. */
export function attachReadonlyRemoteHost(input: { relay: RelayClient; hostId: string; status: () => HostStatusSource }): () => void {
  const ring = new EventRingBuffer(input.hostId);
  const snapshots = new SnapshotService(input.status, () => ring.baseSeq());
  const dispatcher = new AdminDispatcher(input.hostId, snapshots);
  const original = (input.relay as any).options?.onFrame;
  // RelayClient options are intentionally private; the public attachment below
  // is installed by constructing RelayClient with this callback in main wiring.
  void original;
  const unsubscribe = subscribeEventBroadcaster((channel, payload) => {
    const mapped = mapEvent(channel, payload, snapshots); if (!mapped) return;
    for (const frame of ring.publish(mapped)) input.relay.send(frame);
  });
  return () => unsubscribe();
}

/** Build this before RelayClient and pass `onFrame` to its constructor. */
export function createReadonlyRemoteHost(input: { hostId: string; status: () => HostStatusSource }) {
  const ring = new EventRingBuffer(input.hostId);
  const snapshots = new SnapshotService(input.status, () => ring.baseSeq());
  const dispatcher = new AdminDispatcher(input.hostId, snapshots);
  return {
    onFrame: (frame: RemoteFrame, relay: RelayClient) => handleReadonlyRemoteFrame(frame, relay, dispatcher, ring, snapshots),
    attachEvents: (relay: RelayClient) => {
      const unsubscribe = subscribeEventBroadcaster((channel, payload) => {
        const mapped = mapEvent(channel, payload, snapshots); if (!mapped) return;
        for (const event of ring.publish(mapped)) relay.send(event);
      });
      return unsubscribe;
    },
    dispatcher, ring, snapshots
  };
}

export function handleReadonlyRemoteFrame(frame: RemoteFrame, relay: RelayClient, dispatcher: AdminDispatcher, ring: EventRingBuffer, snapshots: SnapshotService): void {
  if (frame.type === "rpc.request") { void dispatcher.dispatch(frame).then(response => { if (response) relay.send(response); }); return; }
  if (frame.type === "resume") { const events = ring.resume(frame.payload.resumeFrom); if (events) { for (const event of events) relay.send(event); return; }
    relay.send({ v: 1, type: "snapshot", id: `msg_snapshot_${Date.now()}`, hostId: frame.hostId, sentAt: new Date().toISOString(), seq: ring.baseSeq(), payload: snapshots.snapshot() }); }
}
