import type { CliStreamItem } from "./streamParser.js";

type ParsedItems = CliStreamItem[] | undefined;
type PrepareItems = (items: ParsedItems, content: string) => CliStreamItem[];
interface Entry {
  content: string;
  items: ParsedItems;
  prepared?: { prepare: PrepareItems; items: CliStreamItem[] };
}

/** Shared results are immutable. A changed body replaces the previous version
 * of a message, so a streaming message cannot fill the cache with old copies. */
export function createStoredStreamItemsCache({
  maxEntries = 80,
  maxChars = 4_000_000
} = {}) {
  const entries = new Map<string, Entry>();
  let chars = 0;
  const read = (content: string, messageId?: string): Entry => {
    const key = messageId ? `id:${messageId}` : `body:${content}`;
    const previous = entries.get(key);
    if (previous) {
      entries.delete(key);
      if (previous.content === content) {
        entries.set(key, previous);
        return previous;
      }
      chars -= previous.content.length;
    }
    let items: ParsedItems;
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) items = parsed;
    } catch { /* Legacy plain text is handled by the display caller. */ }
    const entry: Entry = { content, items };
    if (maxEntries > 0 && content.length <= maxChars) {
      entries.set(key, entry);
      chars += content.length;
      while (entries.size > maxEntries || chars > maxChars) {
        const oldest = entries.keys().next().value!;
        chars -= entries.get(oldest)!.content.length;
        entries.delete(oldest);
      }
    }
    return entry;
  };
  return {
    parse(content: string, messageId?: string): ParsedItems {
      return read(content, messageId).items;
    },
    prepare(content: string, prepare: PrepareItems, messageId?: string): CliStreamItem[] {
      const entry = read(content, messageId);
      if (entry.prepared?.prepare === prepare) return entry.prepared.items;
      const items = prepare(entry.items, content);
      entry.prepared = { prepare, items };
      return items;
    }
  };
}

const shared = createStoredStreamItemsCache();
export const parseStoredStreamItems = shared.parse;
export const prepareStoredStreamItems = shared.prepare;
