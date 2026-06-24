import type { CliStreamItem } from "@/services/cli/parsers";

/** Inline base64 above this size is not persisted inside assistant JSON snapshots. */
export const MAX_PERSISTED_IMAGE_BASE64 = 48 * 1024;

/** Hard cap for plain-text tool/raw output kept in stream items. */
export const MAX_TEXT_STREAM_CHARS = 12_000;

/** Defensive ceiling for assistant text/thinking content. Normal analysis text
 *  stays well below this; only multi-megabyte blobs (e.g. unrecognised base64)
 *  get truncated. Keeps a 67MB video payload from freezing the renderer. */
export const GUARD_TEXT_CHARS = 200_000;

/** Single line written to the run log is capped at this many chars so the main
 *  process never synchronously JSON.stringify + write a multi-megabyte blob. */
export const MAX_LOG_LINE_CHARS = 64_000;

const DATA_URL_PATTERN =
  /data:(?:image|video|audio|application)\/[a-z0-9.+*-]+;base64,[a-zA-Z0-9+/=\s]+/gi;

export interface ExtractedInlineImage {
  data: string;
  mimeType: string;
}

export function extractDataUrlImages(text: string): {
  text: string;
  images: ExtractedInlineImage[];
} {
  if (!text) return { text: "", images: [] };
  // Fast path: most chunks contain no data URL at all. Skip the regex scan
  // (which is O(n) over the whole string) unless a base64 marker is present.
  if (!text.includes("base64,")) return { text, images: [] };

  const images: ExtractedInlineImage[] = [];
  const cleaned = text.replace(DATA_URL_PATTERN, (match) => {
    const normalized = match.replace(/\s+/g, "");
    const parts = normalized.match(
      /^data:((?:image|video|audio|application)\/[a-z0-9.+*-]+);base64,(.+)$/i
    );
    if (!parts) return "[image]";
    images.push({ mimeType: parts[1], data: parts[2] });
    return "[image]";
  });

  return {
    text: collapseImagePlaceholders(cleaned),
    images
  };
}

function collapseImagePlaceholders(text: string): string {
  return text
    .replace(/(\[image\][ \t]*){2,}/g, "[image]\n")
    .replace(/\{[^{}]*"url"\s*:\s*"\[image\]"[^{}]*\}/g, "")
    .replace(/<image>[\s\S]*?<\/image>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncateStreamText(text: string, max = MAX_TEXT_STREAM_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated]`;
}

function summarizeMediaText(text: string, images: ExtractedInlineImage[]): string {
  if (!images.length) return truncateStreamText(text);
  const stripped = collapseImagePlaceholders(text);
  if (!stripped || stripped === "[image]") {
    return `[${mediaLabel(images)} output · ${formatBytesEstimate(images)}]`;
  }
  return truncateStreamText(stripped);
}

function mediaLabel(images: ExtractedInlineImage[]): string {
  const mime = images[0]?.mimeType ?? "";
  if (mime.startsWith("video/")) return "Video";
  if (mime.startsWith("audio/")) return "Audio";
  return "Image";
}

function formatBytesEstimate(images: ExtractedInlineImage[]): string {
  const bytes = images.reduce((sum, image) => sum + image.data.length, 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export type ImagePreviewRegistrar = (
  image: ExtractedInlineImage
) => string | undefined;

function isToolImagePreview(item: CliStreamItem): boolean {
  return item.kind === "content-block" && item.blockType === "image";
}

export function sanitizeStreamItems(
  items: CliStreamItem[],
  registerPreview?: ImagePreviewRegistrar
): CliStreamItem[] {
  const out: CliStreamItem[] = [];

  for (const item of items) {
    if (item.kind === "tool-call") {
      const next: Extract<CliStreamItem, { kind: "tool-call" }> = { ...item };
      if (typeof next.output === "string" && next.output.length > 0) {
        const { text, images } = extractDataUrlImages(next.output);
        next.output = summarizeMediaText(text, images);
      }
      if (next.toolOutputs?.length) {
        next.toolOutputs = sanitizeStreamItems(
          next.toolOutputs,
          registerPreview
        ).filter(
          (entry) => !isToolImagePreview(entry)
        ) as Extract<CliStreamItem, { kind: "tool-call" }>["toolOutputs"];
      }
      out.push(next);
      continue;
    }

    if (item.kind === "content-block" && item.blockType === "resource" && item.text) {
      const { text, images } = extractDataUrlImages(item.text);
      const nextText = summarizeMediaText(text, images);
      if (nextText !== item.text) {
        out.push({ ...item, text: nextText });
        continue;
      }
    }

    if (item.kind === "tool-result" || item.kind === "raw") {
      const { text, images } = extractDataUrlImages(item.content);
      const nextContent = summarizeMediaText(text, images);
      out.push(
        nextContent !== item.content
          ? { ...item, content: nextContent }
          : item
      );
      continue;
    }

    if (item.kind === "text" || item.kind === "thinking") {
      const { text, images } = extractDataUrlImages(item.content);
      if (images.length > 0) {
        out.push({ ...item, content: summarizeMediaText(text, images) });
      } else if (item.content.length > GUARD_TEXT_CHARS) {
        // Defensive guard: even without a recognised data URL, a single text
        // item must never carry a multi-megabyte payload into the snapshot.
        out.push({ ...item, content: truncateStreamText(item.content, GUARD_TEXT_CHARS) });
      } else {
        out.push(item);
      }
      continue;
    }

    if (item.kind === "content-block" && item.blockType === "image" && item.data) {
      if (item.data.length > MAX_PERSISTED_IMAGE_BASE64) {
        const previewKey = registerPreview?.({
          data: item.data,
          mimeType: item.mimeType ?? "image/png"
        });
        if (previewKey) {
          out.push({
            kind: "content-block",
            blockType: "image",
            mimeType: item.mimeType,
            previewKey,
            ...(item.name ? { name: item.name } : {}),
            ...(item.title ? { title: item.title } : {})
          });
          continue;
        }
      }
    }

    out.push(item);
  }

  return out;
}

/** Compact tool/raw output for display without inline image previews. */
export function prepareToolResultText(content: string): string {
  const { text, images } = extractDataUrlImages(content);
  return summarizeMediaText(text, images);
}
