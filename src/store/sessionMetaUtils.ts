import type { CliStreamItem } from "@/services/cli/parsers";
import { parseStoredStreamItems } from "@freebuddy/cli-stream";
import type { ConversationMessage } from "@/services/cli/types";

export type AvailableCommandItem = Extract<
  CliStreamItem,
  { kind: "available-commands" }
>["commands"][number];

export type ConfigOptionItem = Extract<
  CliStreamItem,
  { kind: "config-options" }
>["options"][number];

export type SessionInfoItem = Extract<CliStreamItem, { kind: "session" }>;

function parseMessageItems(content: string, messageId?: string): CliStreamItem[] {
  return parseStoredStreamItems(content, messageId) ?? [];
}

function latestItemFromItems<T extends CliStreamItem["kind"]>(
  items: CliStreamItem[],
  kind: T
): Extract<CliStreamItem, { kind: T }> | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.kind === kind) {
      return item as Extract<CliStreamItem, { kind: T }>;
    }
  }
  return undefined;
}

function latestItemFromMessages<T extends CliStreamItem["kind"]>(
  messages: ConversationMessage[],
  kind: T
): Extract<CliStreamItem, { kind: T }> | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    const item = latestItemFromItems(parseMessageItems(message.content, message.id), kind);
    if (item) return item;
  }
  return undefined;
}

export function latestAvailableCommandsFromItems(
  items: CliStreamItem[]
): AvailableCommandItem[] {
  return latestItemFromItems(items, "available-commands")?.commands ?? [];
}

export function latestConfigOptionsFromItems(
  items: CliStreamItem[]
): ConfigOptionItem[] {
  return latestItemFromItems(items, "config-options")?.options ?? [];
}

export function latestAvailableCommandsFromMessages(
  messages: ConversationMessage[]
): AvailableCommandItem[] {
  return latestItemFromMessages(messages, "available-commands")?.commands ?? [];
}

export function latestConfigOptionsFromMessages(
  messages: ConversationMessage[]
): ConfigOptionItem[] {
  return latestItemFromMessages(messages, "config-options")?.options ?? [];
}

export function latestSessionInfoFromMessages(
  messages: ConversationMessage[]
): SessionInfoItem | undefined {
  return latestItemFromMessages(messages, "session");
}

// Walk every config-options item in chronological order (oldest first) and
// merge by id. A later partial update that only carries an override/currentValue
// (and no `values`) must not evict the full candidate list an earlier complete
// update provided — otherwise the picker trigger still renders the override
// label while the dropdown panel goes empty.
function mergeConfigOptionsChronologically(
  itemLists: CliStreamItem[][]
): ConfigOptionItem[] {
  const byId = new Map<string, ConfigOptionItem>();
  for (const items of itemLists) {
    for (const item of items) {
      if (item.kind !== "config-options") continue;
      for (const option of item.options) {
        const existing = byId.get(option.id);
        if (!existing) {
          byId.set(option.id, option);
          continue;
        }
        const incomingValues = Array.isArray(option.values)
          ? option.values
          : undefined;
        const mergedValues =
          incomingValues && incomingValues.length > 0
            ? incomingValues
            : existing.values;
        byId.set(option.id, {
          ...existing,
          ...option,
          ...(mergedValues && mergedValues.length > 0
            ? { values: mergedValues }
            : {})
        });
      }
    }
  }
  return Array.from(byId.values());
}

export function mergeSessionMetaItems(
  messageItems: CliStreamItem[],
  liveItems: CliStreamItem[] | undefined
): {
  commands: AvailableCommandItem[];
  configOptions: ConfigOptionItem[];
} {
  const commands =
    latestAvailableCommandsFromItems(liveItems ?? []).length > 0
      ? latestAvailableCommandsFromItems(liveItems ?? [])
      : latestAvailableCommandsFromItems(messageItems);
  const configOptions = mergeConfigOptionsChronologically([
    messageItems,
    liveItems ?? []
  ]);
  return { commands, configOptions };
}
