import type { ReactNode } from "react";

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { CliStreamItem } from "@/services/cli/parsers";
import { dedupeCommands, dedupeToolResults } from "@/store/conversationUtils";
import { useImagePreviewStore } from "@/store/imagePreviewStore";
import { useTerminalStore } from "@/store/terminalStore";
import { prepareDisplayText } from "@/utils/streamMedia";
import { attachmentPreviewUrl, formatBytes } from "@/utils/chatAttachments";
import { useImageLightbox } from "./ImageLightbox";

const IMAGE_PATH_EXTENSIONS = "png|jpe?g|webp|gif|bmp|svg|avif|heic|heif";
const IMAGE_PATH_REGEX = new RegExp(
  // Absolute POSIX path or Windows drive path ending in a known image extension.
  `(?:/[^\\s)\\]\`'"<>]+|[A-Za-z]:[\\\\/][^\\s)\\]\`'"<>]+)\\.(?:${IMAGE_PATH_EXTENSIONS})`,
  "gi"
);
const IMAGE_PATH_FULL_REGEX = new RegExp(`^${IMAGE_PATH_REGEX.source}$`, "i");
const MARKDOWN_IMAGE_REGEX = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function isImagePath(value: string): boolean {
  return IMAGE_PATH_FULL_REGEX.test(value.trim());
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
}

function resolveImageSrc(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (isHttpUrl(value)) return value;
  // Absolute local path (POSIX or Windows). Route through custom protocol.
  if (/^([A-Za-z]:[\\/]|\/)/.test(value)) {
    return attachmentPreviewUrl(value);
  }
  // Anything else (relative, ~/, etc.) is rendered as plain text by callers.
  return "";
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function formatCost(amount: number, currency?: string): string {
  const value = amount.toFixed(amount < 0.01 ? 4 : 2);
  return currency === "USD" ? `$${value}` : `${value} ${currency ?? ""}`.trim();
}

function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Strip markdown image syntax: image previews are rendered as separate figure blocks.
  const cleaned = text.replace(MARKDOWN_IMAGE_REGEX, "").replace(/[ \t]{2,}/g, " ");
  const parts = cleaned.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);

  parts.forEach((part, index) => {
    if (!part) return;
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("`") && part.endsWith("`")) {
      nodes.push(<code key={key}>{part.slice(1, -1)}</code>);
      return;
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>);
      return;
    }
    const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const label = linkMatch[1];
      const href = resolveLinkHref(linkMatch[2]);
      if (href) {
        nodes.push(
          <a key={key} href={href} target="_blank" rel="noreferrer noopener">
            {label}
          </a>
        );
        return;
      }
    }
    nodes.push(part);
  });

  return nodes;
}

function resolveLinkHref(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  if (isHttpUrl(value)) return value;
  if (/^([A-Za-z]:[\\/]|\/)/.test(value)) {
    return attachmentPreviewUrl(value);
  }
  if (/^file:\/\//i.test(value)) {
    return value;
  }
  return value;
}

function dataUrlFromBase64(data: string, mimeType: string): string {
  return `data:${mimeType};base64,${data}`;
}

function StreamToolResultBody({ content }: { content: string }) {
  const { t } = useTranslation();
  const prepared = prepareDisplayText(content);

  return (
    <>
      {prepared.images.map((image, index) => (
        <MessageImage
          key={`tool-image-${index}`}
          src={dataUrlFromBase64(image.data, image.mimeType)}
          alt=""
        />
      ))}
      {hasVisibleContent(prepared.text) ? (
        <pre>{prepared.text}</pre>
      ) : prepared.images.length === 0 ? (
        <div className="stream-tool-empty">{t("stream.noOutput")}</div>
      ) : null}
    </>
  );
}

interface InlineImageRef {
  alt: string;
  src: string;
}

/** Collect image references from a chunk of text: markdown ![alt](src) and bare absolute paths. */
function collectInlineImages(text: string): InlineImageRef[] {
  const seen = new Set<string>();
  const refs: InlineImageRef[] = [];
  let stripped = text;

  stripped = stripped.replace(MARKDOWN_IMAGE_REGEX, (_match, alt: string, src: string) => {
    const resolved = resolveImageSrc(src) || (isHttpUrl(src) ? src : "");
    if (resolved && !seen.has(resolved)) {
      seen.add(resolved);
      refs.push({ alt: (alt || "").trim(), src: resolved });
    }
    return " ";
  });

  const matches = stripped.match(IMAGE_PATH_REGEX);
  if (matches) {
    for (const raw of matches) {
      const resolved = resolveImageSrc(raw);
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      refs.push({ alt: "", src: resolved });
    }
  }
  return refs;
}

function MessageImage({ src, alt }: { alt: string; src: string }) {
  const { t } = useTranslation();
  const { open } = useImageLightbox();
  return (
    <figure className="markdown-image-figure">
      <button
        type="button"
        className="markdown-image-button"
        onClick={() => open({ src, alt })}
        aria-label={alt ? t("attachments.previewName", { name: alt }) : t("attachments.previewImage")}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="markdown-image"
          onError={(event) => {
            const figure = event.currentTarget.closest("figure");
            if (figure) figure.classList.add("markdown-image-error");
          }}
        />
      </button>
      {alt ? <figcaption>{alt}</figcaption> : null}
    </figure>
  );
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line: string) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function MarkdownText({ content }: { content: string }) {
  const blocks: ReactNode[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      blocks.push(
        <Tag key={`h-${i}`} className="markdown-heading">
          {renderInline(text, `h-${i}`)}
        </Tag>
      );
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={`quote-${i}`} className="markdown-blockquote">
          {renderInline(quoteLines.join("\n"), `quote-${i}`)}
        </blockquote>
      );
      continue;
    }

    if (line.trim().startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre className="markdown-code" key={`code-${i}`}>
          <code>{code.join("\n")}</code>
        </pre>
      );
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const headers = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i += 1;
      }
      blocks.push(
        <div className="markdown-table-wrap" key={`table-${i}`}>
          <table>
            <thead>
              <tr>
                {headers.map((header, headerIndex) => (
                  <th key={headerIndex}>{renderInline(header, `th-${i}-${headerIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>
                      {renderInline(row[cellIndex] ?? "", `td-${i}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }

    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        i += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      blocks.push(
        <ListTag key={`list-${i}`}>
          {items.map((item, itemIndex) => (
            <li key={itemIndex}>{renderInline(item, `li-${i}-${itemIndex}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    const paragraph = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) &&
      !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i])
    ) {
      paragraph.push(lines[i]);
      i += 1;
    }

    const paragraphText = paragraph.join("\n");
    const images = collectInlineImages(paragraphText);
    const trimmed = paragraphText.trim();
    const isImageOnly =
      images.length > 0 &&
      (isImagePath(trimmed) || /^!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\)$/.test(trimmed));

    if (!isImageOnly) {
      blocks.push(
        <p key={`p-${i}`}>{renderInline(paragraphText, `p-${i}`)}</p>
      );
    }

    images.forEach((image, imageIndex) => {
      blocks.push(
        <MessageImage
          key={`img-${i}-${imageIndex}`}
          src={image.src}
          alt={image.alt}
        />
      );
    });
  }

  return <div className="markdown-body">{blocks}</div>;
}

function StreamContentBlock({
  item
}: {
  item: Extract<CliStreamItem, { kind: "content-block" }>;
}) {
  const { t } = useTranslation();

  switch (item.blockType) {
    case "image": {
      const previewSrc = item.previewKey
        ? useImagePreviewStore.getState().byKey[item.previewKey]
        : undefined;
      if (!item.data && !previewSrc) return null;
      const src =
        previewSrc ??
        dataUrlFromBase64(item.data!, item.mimeType ?? "image/png");
      return <MessageImage src={src} alt={item.title ?? item.name ?? ""} />;
    }
    case "audio": {
      if (!item.data) return null;
      const src = dataUrlFromBase64(item.data, item.mimeType ?? "audio/wav");
      return (
        <div className="stream-content-block stream-audio-block">
          <audio controls preload="metadata" src={src} className="stream-audio" />
        </div>
      );
    }
    case "resource_link": {
      const href = item.uri ? resolveLinkHref(item.uri) : "";
      const label = item.title || item.name || item.uri || t("stream.resourceLink");
      const meta = [
        item.mimeType,
        typeof item.size === "number" ? formatBytes(item.size) : ""
      ]
        .filter(Boolean)
        .join(" · ");
      return (
        <div className="stream-content-block stream-resource-link">
          {href ? (
            <a href={href} target="_blank" rel="noreferrer noopener" title={item.uri}>
              {label}
            </a>
          ) : (
            <span>{label}</span>
          )}
          {item.description ? (
            <div className="stream-resource-description">{item.description}</div>
          ) : null}
          {meta ? <div className="stream-resource-meta">{meta}</div> : null}
        </div>
      );
    }
    case "resource": {
      if (item.text) {
        const prepared = prepareDisplayText(item.text);
        return (
          <div className="stream-content-block stream-embedded-resource">
            {(item.title || item.name || item.uri) && (
              <div className="stream-resource-label">
                {item.title || item.name || item.uri}
              </div>
            )}
            {prepared.images.map((image, index) => (
              <MessageImage
                key={`resource-image-${index}`}
                src={dataUrlFromBase64(image.data, image.mimeType)}
                alt=""
              />
            ))}
            {hasVisibleContent(prepared.text) ? (
              <pre className="stream-embedded-resource-text">{prepared.text}</pre>
            ) : null}
          </div>
        );
      }
      if (item.data && item.mimeType?.startsWith("image/")) {
        const src = dataUrlFromBase64(item.data, item.mimeType);
        return <MessageImage src={src} alt={item.title ?? item.name ?? ""} />;
      }
      if (item.uri) {
        const href = resolveLinkHref(item.uri);
        const label = item.title || item.name || item.uri;
        return (
          <div className="stream-content-block stream-embedded-resource">
            <a href={href} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          </div>
        );
      }
      return null;
    }
    default:
      return null;
  }
}

function summarizeValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(String).join(" ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const direct =
      record.path ??
      record.file ??
      record.command ??
      record.cmd ??
      record.name ??
      record.query ??
      record.input;
    if (direct != null) return summarizeValue(direct);
  }
  return JSON.stringify(value);
}

function truncate(value: string, max = 96) {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function StreamStepIcon({ children }: { children: ReactNode }) {
  return (
    <span className="stream-step-icon" aria-hidden="true">
      <svg
        className="stream-step-icon-svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </span>
  );
}

function ToolKindIcon({
  toolKind
}: {
  toolKind?: Extract<CliStreamItem, { kind: "tool-call" }>["toolKind"];
}) {
  switch (toolKind) {
    case "read":
      return (
        <StreamStepIcon>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </StreamStepIcon>
      );
    case "edit":
      return (
        <StreamStepIcon>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </StreamStepIcon>
      );
    case "delete":
      return (
        <StreamStepIcon>
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </StreamStepIcon>
      );
    case "move":
      return (
        <StreamStepIcon>
          <path d="M5 12h14" />
          <path d="m13 18 6-6-6-6" />
        </StreamStepIcon>
      );
    case "search":
      return (
        <StreamStepIcon>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </StreamStepIcon>
      );
    case "execute":
      return (
        <StreamStepIcon>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </StreamStepIcon>
      );
    case "fetch":
      return (
        <StreamStepIcon>
          <path d="M12 3v12" />
          <path d="m7 10 5 5 5-5" />
          <path d="M5 21h14" />
        </StreamStepIcon>
      );
    case "think":
      return (
        <StreamStepIcon>
          <path d="M9 18h6" />
          <path d="M10 22h4" />
          <path d="M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z" />
        </StreamStepIcon>
      );
    case "mode":
      return (
        <StreamStepIcon>
          <line x1="4" y1="21" x2="4" y2="14" />
          <line x1="4" y1="10" x2="4" y2="3" />
          <line x1="12" y1="21" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12" y2="3" />
          <line x1="20" y1="21" x2="20" y2="16" />
          <line x1="20" y1="12" x2="20" y2="3" />
          <line x1="2" y1="14" x2="6" y2="14" />
          <line x1="10" y1="8" x2="14" y2="8" />
          <line x1="18" y1="16" x2="22" y2="16" />
        </StreamStepIcon>
      );
    default:
      return (
        <StreamStepIcon>
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </StreamStepIcon>
      );
  }
}

function toolStatusMeta(
  call: Extract<CliStreamItem, { kind: "tool-call" }>,
  t: TFunction
) {
  switch (call.status) {
    case "pending":
      return { className: "pending", label: t("stream.statusPending") };
    case "running":
      return { className: "running", label: t("stream.statusRunning") };
    case "completed":
      return { className: "completed", label: t("stream.statusCompleted") };
    case "failed":
      return { className: "failed", label: t("stream.statusFailed") };
    default:
      return undefined;
  }
}

function toolActionLabel(
  item: Extract<CliStreamItem, { kind: "tool-call" }>,
  t: TFunction
) {
  const locationTarget = item.locations?.[0]?.path;
  const target = truncate(locationTarget ?? summarizeValue(item.input));

  switch (item.toolKind) {
    case "read":
      return t("stream.read", { target: target || item.tool });
    case "edit":
      return t("stream.edit", { target: target || item.tool });
    case "execute":
      return t("stream.exec", { target: target || item.tool });
    case "search":
      return target ? `${item.tool} ${target}` : item.tool;
    case "delete":
      return t("stream.delete", { target: target || item.tool });
    case "move":
      return t("stream.move", { target: target || item.tool });
    default:
      break;
  }

  const tool = item.tool.toLowerCase();
  if (tool.includes("read") || tool.includes("open")) {
    return t("stream.read", { target: target || item.tool });
  }
  if (tool.includes("write") || tool.includes("edit") || tool.includes("patch")) {
    return t("stream.edit", { target: target || item.tool });
  }
  if (tool.includes("command") || tool.includes("exec") || tool.includes("shell")) {
    return t("stream.exec", { target: target || item.tool });
  }
  return target ? `${item.tool} ${target}` : item.tool;
}

function hasVisibleContent(content: string) {
  return content.trim().length > 0;
}

function formatValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  ) {
    return "";
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toolGroupLabel(
  item: Extract<CliStreamItem, { kind: "tool-call" }>,
  t: TFunction
) {
  const tool = item.tool.toLowerCase();
  if (tool.includes("search") || tool.includes("fetch")) return item.tool;
  return toolActionLabel(item, t);
}

export function StreamToolInvocation({
  call,
  results,
  commands = [],
  extras = []
}: {
  call: Extract<CliStreamItem, { kind: "tool-call" }>;
  results: Extract<CliStreamItem, { kind: "tool-result" }>[];
  commands?: Extract<CliStreamItem, { kind: "command" }>[];
  extras?: CliStreamItem[];
}) {
  const visibleResults = dedupeToolResults(results);
  const visibleCommands = dedupeCommands(commands);
  const hasError = call.isError || visibleResults.some((result) => result.isError);
  const input = formatValue(call.input);
  const { t } = useTranslation();
  const statusMeta = toolStatusMeta(call, t);
  const hasBody =
    Boolean(input) ||
    visibleCommands.length > 0 ||
    visibleResults.length > 0 ||
    extras.length > 0;
  const showDoneMeta =
    call.status === "completed" &&
    !visibleResults.some((result) => hasVisibleContent(result.content)) &&
    visibleCommands.length === 0 &&
    extras.length === 0;

  return (
    <details
      className={`stream-tool-invocation${hasError ? " error" : ""}${
        statusMeta ? ` status-${statusMeta.className}` : ""
      }`}
      open={call.status === "running" ? true : undefined}
    >
      <summary>
        <ToolKindIcon toolKind={call.toolKind} />
        <span className="stream-tool-summary-main">{toolGroupLabel(call, t)}</span>
        {call.locations?.length ? (
          <span className="stream-tool-locations">
            {call.locations.map((location, index) => {
              const href = resolveLinkHref(location.path);
              return href ? (
                <a
                  key={`${location.path}-${index}`}
                  href={href}
                  className="stream-tool-location"
                  title={location.path}
                  onClick={(event) => event.stopPropagation()}
                >
                  {truncate(location.path, 48)}
                </a>
              ) : (
                <span key={`${location.path}-${index}`} className="stream-tool-location">
                  {truncate(location.path, 48)}
                </span>
              );
            })}
          </span>
        ) : null}
        {statusMeta ? (
          <span className={`stream-tool-status ${statusMeta.className}`}>
            {call.status === "running" ? (
              <span className="stream-tool-spinner" aria-hidden="true" />
            ) : null}
            <span>{statusMeta.label}</span>
          </span>
        ) : hasBody ? (
          <span className="stream-tool-summary-meta">
            {visibleResults.some((result) => hasVisibleContent(result.content)) ||
            visibleCommands.length > 0 ||
            extras.length > 0
              ? t("stream.summaryResult")
              : showDoneMeta
                ? t("stream.summaryDone")
                : null}
          </span>
        ) : null}
      </summary>
      <div className="stream-tool-body">
        {input && (
          <div className="stream-tool-section">
            <span className="stream-label">{t("stream.input")}</span>
            <pre>{input}</pre>
          </div>
        )}
        {visibleCommands.map((command, index) => (
          <div className="stream-tool-section" key={`command-${index}`}>
            <span className="stream-label">{t("stream.command")}</span>
            <pre>{command.command}</pre>
            {command.cwd && <div className="stream-tool-empty">{command.cwd}</div>}
          </div>
        ))}
        {extras.map((extra, index) => (
          <div className="stream-tool-section" key={`extra-${index}`}>
            <StreamItem item={extra} />
          </div>
        ))}
        {visibleResults.map((result, index) => (
          <div className="stream-tool-section" key={`${result.id ?? "result"}-${index}`}>
            <span className="stream-label">
              {t("stream.result", { tool: result.tool })}
              {result.isError ? ` ${t("stream.errorTag")}` : ""}
            </span>
            {hasVisibleContent(result.content) || /data:image\//i.test(result.content) ? (
              <StreamToolResultBody content={result.content} />
            ) : (
              <div className="stream-tool-empty">{t("stream.noOutput")}</div>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}

function TerminalEmbed({
  item
}: {
  item: Extract<CliStreamItem, { kind: "terminal-embed" }>;
}) {
  const { t } = useTranslation();
  const live = useTerminalStore((state) => state.byId[item.terminalId]);
  const output = live?.output ?? item.output ?? "";
  const exited = live?.exited ?? item.exited ?? false;
  const running = live?.running ?? item.running ?? !exited;
  const truncated = live?.truncated ?? item.truncated;
  const exitCode = live?.exitCode ?? item.exitCode;

  return (
    <div className={`stream-terminal-embed${running ? " running" : ""}`}>
      <div className="stream-terminal-header">
        <span className="stream-label">{t("stream.terminal")}</span>
        <code className="stream-terminal-id">{item.terminalId}</code>
        {running ? (
          <span className="stream-terminal-running">{t("stream.terminalRunning")}</span>
        ) : exitCode != null ? (
          <span
            className={`stream-terminal-exit${exitCode === 0 ? " ok" : " failed"}`}
          >
            {t("stream.exitCode", { code: exitCode })}
          </span>
        ) : null}
      </div>
      <pre className="stream-terminal-output">{output || t("stream.noOutput")}</pre>
      {truncated ? (
        <div className="stream-terminal-truncated">{t("stream.terminalTruncated")}</div>
      ) : null}
    </div>
  );
}

export function StreamItem({ item }: { item: CliStreamItem }) {
  const { t } = useTranslation();
  switch (item.kind) {
    case "text":
      return (
        <div className={`stream-text role-${item.role}`}>
          <MarkdownText content={item.content} />
        </div>
      );
    case "thinking":
      return (
        <details className="stream-thinking">
          <summary>{t("stream.thinking")}</summary>
          <MarkdownText content={item.content} />
        </details>
      );
    case "content-block":
      return <StreamContentBlock item={item} />;
    case "tool-call":
      return (
        <div className="stream-step stream-tool-call">
          <ToolKindIcon toolKind={item.toolKind} />
          <span>{toolActionLabel(item, t)}</span>
        </div>
      );
    case "tool-result":
      if (
        !hasVisibleContent(item.content) &&
        !/data:image\//i.test(item.content)
      ) {
        return (
          <div className={`stream-step stream-tool-result-empty${item.isError ? " error" : ""}`}>
            <span className="stream-step-icon">↳</span>
            <span className="stream-label">{t("stream.result", { tool: item.tool })}</span>
            {item.isError && <span className="stream-error-suffix">{t("stream.errorTag")}</span>}
          </div>
        );
      }
      return (
        <details className={`stream-tool-result${item.isError ? " error" : ""}`}>
          <summary>
            <span className="stream-label stream-summary-label">
              {t("stream.result", { tool: item.tool })}
            </span>
            {item.isError && <span className="stream-error-suffix">{t("stream.errorTag")}</span>}
          </summary>
          <StreamToolResultBody content={item.content} />
        </details>
      );
    case "command":
      return (
        <div className="stream-command">
          <span className="stream-label">{t("stream.terminal")}</span>
          <code>{item.command}</code>
          {item.cwd && <span className="cwd">{item.cwd}</span>}
        </div>
      );
    case "command-output":
      return (
        <pre className={`stream-cmd-output ${item.stream ?? "stdout"}`}>
          {item.content}
        </pre>
      );
    case "file-edit":
      return (
        <details className="stream-file-edit">
          <summary>{item.action} {item.path}</summary>
          {item.oldText != null && item.newText != null ? (
            <div className="stream-diff">
              <pre className="stream-diff-old">{item.oldText}</pre>
              <pre className="stream-diff-new">{item.newText}</pre>
            </div>
          ) : item.patch ? (
            <pre>{item.patch}</pre>
          ) : null}
        </details>
      );
    case "terminal-embed":
      return <TerminalEmbed item={item} />;
    case "session":
      return (
        <div className="stream-meta session-meta">
          <span className="stream-label">{t("stream.sessionLabel")}</span>{" "}
          <code>{item.sessionId}</code>
          {item.title ? ` — ${item.title}` : ""}
        </div>
      );
    case "usage": {
      const hasContext =
        item.contextUsed != null || item.contextSize != null;
      const used = item.contextUsed != null ? formatTokens(item.contextUsed) : "–";
      const total = item.contextSize != null ? ` / ${formatTokens(item.contextSize)}` : "";
      return (
        <div className="stream-meta">
          <span className="stream-label">{t("stream.usageLabel")}</span>
          {hasContext ? (
            <span>{t("stream.contextUsage", { used, total })}</span>
          ) : (
            <span>
              {t("stream.tokenUsage", {
                input: item.inputTokens ?? "–",
                output: item.outputTokens ?? "–"
              })}
            </span>
          )}
          {item.costAmount != null && (
            <span className="stream-cost"> · {formatCost(item.costAmount, item.costCurrency)}</span>
          )}
          {item.costAmount == null && item.totalCost != null && (
            <span className="stream-cost"> · ${item.totalCost.toFixed(4)}</span>
          )}
        </div>
      );
    }
    case "error":
      return (
        <div className="stream-error">
          <div>
            <span className="stream-label">{t("stream.errorLabel")}</span> {item.message}
          </div>
          {item.details?.length ? (
            <details className="stream-error-details">
              <summary>{t("stream.viewRawLog", { count: item.details.length })}</summary>
              <pre>{item.details.join("\n")}</pre>
            </details>
          ) : null}
        </div>
      );
    case "done":
      return (
        <div className={`stream-meta done${item.exitCode && item.exitCode !== 0 ? " failed" : ""}`}>
          <span className="stream-label">
            {item.exitCode && item.exitCode !== 0 ? t("stream.exitLabel") : t("stream.doneOk")}
          </span>
          {item.exitCode != null && (
            <span> {t("stream.exitCode", { code: item.exitCode })}</span>
          )}
        </div>
      );
    case "raw": {
      const prepared = prepareDisplayText(item.content);
      return (
        <div className="stream-raw">
          {prepared.images.map((image, index) => (
            <MessageImage
              key={`raw-image-${index}`}
              src={dataUrlFromBase64(image.data, image.mimeType)}
              alt=""
            />
          ))}
          {hasVisibleContent(prepared.text) ? (
            <pre>{prepared.text}</pre>
          ) : null}
        </div>
      );
    }
    default:
      return null;
  }
}
