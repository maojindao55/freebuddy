import type { FileEditBlobChunk, FileEditContent } from "@freebuddy/protocol";

type ContentResult = { status: "ready"; content: FileEditContent } | { status: "missing" | "large" };
type ReadChunk = (conversationId: string, blobKey: string, offset: number) => Promise<FileEditBlobChunk | undefined>;

export function createFileEditContentLoader(readChunk: ReadChunk, maxBytes = 8 * 1024 * 1024) {
  const cache = new Map<string, { result: ContentResult; bytes: number }>();
  const pending = new Map<string, Promise<ContentResult>>();
  let cacheBytes = 0;
  const read = async (conversationId: string, blobKey: string, key: string): Promise<ContentResult> => {
    let offset = 0;
    let totalBytes: number | undefined;
    let text = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (true) {
      const page = await readChunk(conversationId, blobKey, offset);
      if (!page) return { status: "missing" };
      if (page.totalBytes > maxBytes) return { status: "large" };
      if (totalBytes !== undefined && totalBytes !== page.totalBytes) throw new Error("File edit changed while loading");
      totalBytes = page.totalBytes;
      const bytes = Uint8Array.from(atob(page.data), character => character.charCodeAt(0));
      if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || page.nextOffset !== offset + bytes.length
        || page.nextOffset > totalBytes || (page.hasMore && (page.nextOffset <= offset || page.nextOffset >= totalBytes))
        || (!page.hasMore && page.nextOffset !== totalBytes)) throw new Error("Invalid file edit page");
      text += decoder.decode(bytes, { stream: page.hasMore });
      offset = page.nextOffset;
      if (!page.hasMore) break;
    }
    const content = JSON.parse(text) as FileEditContent;
    if (!content || typeof content !== "object" || Array.isArray(content)
      || [content.oldText, content.newText, content.patch].some(value => value !== undefined && typeof value !== "string")) {
      throw new Error("Invalid file edit content");
    }
    const result: ContentResult = { status: "ready", content };
    const bytes = text.length * 2;
    if (bytes <= maxBytes) {
      while (cache.size && (cacheBytes + bytes > maxBytes || cache.size >= 32)) {
        const oldestKey = cache.keys().next().value!;
        cacheBytes -= cache.get(oldestKey)!.bytes;
        cache.delete(oldestKey);
      }
      cache.set(key, { result, bytes });
      cacheBytes += bytes;
    }
    return result;
  };
  return (conversationId: string, blobKey: string): Promise<ContentResult> => {
    const key = JSON.stringify([conversationId, blobKey]);
    const cached = cache.get(key);
    if (cached) {
      cache.delete(key);
      cache.set(key, cached);
      return Promise.resolve(cached.result);
    }
    const existing = pending.get(key);
    if (existing) return existing;
    const request = read(conversationId, blobKey, key).finally(() => pending.delete(key));
    pending.set(key, request);
    return request;
  };
}
