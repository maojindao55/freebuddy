import type { ReactNode } from "react";

import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";

import type { CliStreamItem } from "@/services/cli/parsers";
import { dedupeCommands, dedupeToolResults } from "@/store/conversationUtils";
import { attachmentPreviewUrl } from "@/utils/chatAttachments";
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
  const parts = cleaned.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

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
    nodes.push(part);
  });

  return nodes;
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

function toolActionLabel(
  item: Extract<CliStreamItem, { kind: "tool-call" }>,
  t: TFunction
) {
  const tool = item.tool.toLowerCase();
  const target = truncate(summarizeValue(item.input));
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
  commands = []
}: {
  call: Extract<CliStreamItem, { kind: "tool-call" }>;
  results: Extract<CliStreamItem, { kind: "tool-result" }>[];
  commands?: Extract<CliStreamItem, { kind: "command" }>[];
}) {
  const visibleResults = dedupeToolResults(results);
  const visibleCommands = dedupeCommands(commands);
  const hasError = visibleResults.some((result) => result.isError);
  const input = formatValue(call.input);
  const { t } = useTranslation();

  return (
    <details className={`stream-tool-invocation${hasError ? " error" : ""}`}>
      <summary>
        <span className="stream-step-icon">⌁</span>
        <span className="stream-tool-summary-main">{toolGroupLabel(call, t)}</span>
        {(visibleResults.length > 0 || visibleCommands.length > 0) && (
          <span className="stream-tool-summary-meta">
            {visibleResults.some((result) => hasVisibleContent(result.content)) ||
            visibleCommands.length > 0
              ? t("stream.summaryResult")
              : t("stream.summaryDone")}
          </span>
        )}
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
        {visibleResults.map((result, index) => (
          <div className="stream-tool-section" key={`${result.id ?? "result"}-${index}`}>
            <span className="stream-label">
              {t("stream.result", { tool: result.tool })}
              {result.isError ? ` ${t("stream.errorTag")}` : ""}
            </span>
            {hasVisibleContent(result.content) ? (
              <pre>{result.content}</pre>
            ) : (
              <div className="stream-tool-empty">{t("stream.noOutput")}</div>
            )}
          </div>
        ))}
      </div>
    </details>
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
    case "tool-call":
      return (
        <div className="stream-step stream-tool-call">
          <span className="stream-step-icon">⌁</span>
          <span>{toolActionLabel(item, t)}</span>
        </div>
      );
    case "tool-result":
      if (!hasVisibleContent(item.content)) {
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
          <pre>{item.content}</pre>
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
          {item.patch && <pre>{item.patch}</pre>}
        </details>
      );
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
    case "raw":
      return <pre className="stream-raw">{item.content}</pre>;
    default:
      return null;
  }
}
