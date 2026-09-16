/**
 * Applies authoritative host state to the App-scoped stores.
 *
 * Two very different operations live here, and the difference is the point:
 *
 * - **Snapshot → replace.** A snapshot is the whole truth at `baseSeq`, so every entity set it
 *   owns is swapped in one go. Each store publishes exactly one complete replacement, so a
 *   subscriber can never observe a half-applied snapshot (new host with the old conversations,
 *   say). Message threads that no longer exist in the snapshot are pruned, because keeping them
 *   would resurrect conversations the host just deleted.
 * - **Event → merge one entity.** Incremental events touch a single entity and are merged by
 *   `updatedAt` (`createdAt` for messages), so an older arrival — a slow page, a late event — can
 *   never roll the cache back.
 *
 * Everything is whitelisted first (`entityFields.ts`) and bounded second: arrays are capped,
 * message threads are capped and evicted least-recently-used, and entities that do not carry a
 * versioning channel are still capped by the store. Nothing here writes to the wire, and nothing
 * here invents a protocol field.
 *
 * Not applied yet (later stages own them): `task.*`, `workflow.*`, `delegation.*`, `run.*` and
 * `terminal.*` entities. Their snapshots are accepted, their incremental events are reported as
 * ignored so the caller can count them, and no store claims to hold them.
 */

import type { AdminStores } from "./adminStores";
import {
  pickConversation,
  pickConversationId,
  pickHostStatus,
  pickMessage,
  pickSnapshotPayload
} from "./entityFields";
import type { EventFrame, RemoteId, SnapshotPayload } from "../protocol/remote.generated";

export interface RemoteStateApplierOptions {
  readonly stores: AdminStores;
  readonly nowMs: () => number;
}

export interface RemoteStateApplier {
  /** False when the payload is not a usable snapshot; no store is touched in that case. */
  applySnapshot(payload: SnapshotPayload): boolean;
  /** True when the event changed a store; false when it was unknown, malformed or ignorable. */
  applyEvent(frame: EventFrame): boolean;
  clearAll(): void;
}

export function createRemoteStateApplier(options: RemoteStateApplierOptions): RemoteStateApplier {
  const { stores } = options;

  return {
    applySnapshot(payload) {
      const clean = pickSnapshotPayload(payload);
      if (clean === null) {
        return false;
      }
      const nowMs = options.nowMs();
      // Order matters: the host mirror first (it carries `baseSeq`), then the lists it owns, then
      // the pruning that depends on those lists.
      stores.host.replaceFromSnapshot(clean, nowMs);
      stores.conversations.replaceFromSnapshot(clean.conversations ?? []);
      stores.messages.retainOnly((clean.conversations ?? []).map((item) => item.conversationId));
      return true;
    },

    applyEvent(frame) {
      const name = frame.payload?.name;
      const data: unknown = frame.payload?.data;

      switch (name) {
        case "host.status.changed": {
          const status = pickHostStatus(data);
          if (status === null) {
            return false;
          }
          return stores.host.setHostStatus(status, options.nowMs());
        }
        case "conversation.created":
        case "conversation.updated": {
          const conversation = pickConversation(data);
          if (conversation === null) {
            return false;
          }
          stores.conversations.upsert(conversation);
          return true;
        }
        case "conversation.deleted": {
          const conversationId = pickConversationId(data);
          if (conversationId === null) {
            return false;
          }
          stores.conversations.remove(conversationId as RemoteId);
          stores.messages.clearThread(conversationId as RemoteId);
          return true;
        }
        case "message.created":
        case "message.updated": {
          const message = pickMessage(data);
          if (message === null) {
            return false;
          }
          stores.messages.upsert(message);
          return true;
        }
        default:
          // Known to the protocol but not owned by this stage: never fabricated, never cached.
          return false;
      }
    },

    clearAll() {
      stores.host.clear();
      stores.conversations.reset();
      stores.messages.reset();
    }
  };
}
