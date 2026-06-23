import type { CliStreamItem } from "@/services/cli/parsers";

/** Inline base64 above this size is not persisted inside assistant JSON snapshots. */
export const MAX_PERSISTED_IMAGE_BASE64 = 48 * 1024;

/** Hard cap for plain-text tool/raw output kept in stream items. */
export const MAX_TEXT_STREAM_CHARS = 12_000;

const DATA_URL_PATTERN =
  /data:image\/[a-z0-9.+*-]+;base64,[a-z0-9+/=\s]+/gi;

export interface ExtractedInlineImage {
  data: string;
  mimeType: string;
}

export function extractDataUrlImages(text: string): {
  text: string;
  images: ExtractedInlineImage[];
} {
  if (!text) return { text: "", images: [] };

  const images: ExtractedInlineImage[] = [];
  const cleaned = text.replace(DATA_URL_PATTERN, (match) => {
    const normalized = match.replace(/\s+/g, "");
    const parts = normalized.match(/^data:(image\/[a-z0-9.+*-]+);base64,(.+)$/i);
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
    return `[Image output · ${formatBytesEstimate(images)}]`;
  }
  return truncateStreamText(stripped);
}

function formatBytesEstimate(images: ExtractedInlineImage[]): string {
  const bytes = images.reduce((sum, image) => sum + image.data.length, 0);
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function imageBlocksFromExtracted(
  images: ExtractedInlineImage[],
  previewKeyFor: (image: ExtractedInlineImage) => string | undefined
): CliStreamItem[] {
  return images.map((image) => {
    const previewKey = previewKeyFor(image);
    if (previewKey) {
      return {
        kind: "content-block",
        blockType: "image",
        mimeType: image.mimeType,
        previewKey
      };
    }
    return {
      kind: "content-block",
      blockType: "image",
      mimeType: image.mimeType,
      data: image.data
    };
  });
}

export type ImagePreviewRegistrar = (
  image: ExtractedInlineImage
) => string | undefined;

export function sanitizeStreamItems(
  items: CliStreamItem[],
  registerPreview?: ImagePreviewRegistrar
): CliStreamItem[] {
  const out: CliStreamItem[] = [];

  for (const item of items) {
    if (item.kind === "tool-result" || item.kind === "raw") {
      const { text, images } = extractDataUrlImages(item.content);
      const nextContent = summarizeMediaText(text, images);
      if (nextContent !== item.content || images.length > 0) {
        out.push({ ...item, content: nextContent });
      } else {
        out.push(item);
      }
      out.push(
        ...imageBlocksFromExtracted(images, (image) => registerPreview?.(image))
      );
      continue;
    }

    if (item.kind === "text") {
      const { text, images } = extractDataUrlImages(item.content);
      if (images.length > 0) {
        out.push({ ...item, content: text });
        out.push(
          ...imageBlocksFromExtracted(images, (image) => registerPreview?.(image))
        );
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

export function prepareDisplayText(content: string): {
  text: string;
  images: ExtractedInlineImage[];
} {
  const { text, images } = extractDataUrlImages(content);
  return {
    text: summarizeMediaText(text, images),
    images
  };
}
