/**
 * App-scoped store bundle.
 *
 * Stores are caches of server state, never a source of truth, and they are all host-scoped: the
 * entities of one host must never be visible while another host is selected. Keeping them in one
 * bundle is what makes "clear everything for the host you just switched to" a single, atomic,
 * easy-to-audit operation instead of four scattered resets.
 *
 * The bundle is created explicitly (tests, and any future per-host experiment) and also exposed
 * as a process-wide singleton owned by the App — page-level stores would die with the page, and
 * recovery state must not.
 */

import { createConnectionStore, type ConnectionStore } from "./connectionStore";
import { createConversationStore, type ConversationStore } from "./conversationStore";
import { createHostStore, type HostStore } from "./hostStore";
import { createMessageStore, type MessageStore } from "./messageStore";

export interface AdminStores {
  readonly host: HostStore;
  readonly conversations: ConversationStore;
  readonly messages: MessageStore;
  readonly connection: ConnectionStore;
}

export function createAdminStores(): AdminStores {
  return {
    host: createHostStore(),
    conversations: createConversationStore(),
    messages: createMessageStore(),
    connection: createConnectionStore()
  };
}

let singleton: AdminStores | null = null;

export function getAdminStores(): AdminStores {
  if (!singleton) {
    singleton = createAdminStores();
  }
  return singleton;
}

export function resetAdminStores(): void {
  singleton = null;
}
