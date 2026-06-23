import type { CliStreamItem } from "@/services/cli/parsers";
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

function parseMessageItems(content: string): CliStreamItem[] {
  try {
    const items = JSON.parse(content);
    return Array.isArray(items) ? (items as CliStreamItem[]) : [];
  } catch {
    return [];
  }
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
    const item = latestItemFromItems(parseMessageItems(message.content), kind);
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
  const configOptions =
    latestConfigOptionsFromItems(liveItems ?? []).length > 0
      ? latestConfigOptionsFromItems(liveItems ?? [])
      : latestConfigOptionsFromItems(messageItems);
  return { commands, configOptions };
}
