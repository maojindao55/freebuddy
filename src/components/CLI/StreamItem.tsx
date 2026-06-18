import type { ReactNode } from "react";

import type { CliStreamItem } from "@/services/cli/parsers";

function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);

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

    blocks.push(
      <p key={`p-${i}`}>{renderInline(paragraph.join("\n"), `p-${i}`)}</p>
    );
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

function toolActionLabel(item: Extract<CliStreamItem, { kind: "tool-call" }>) {
  const tool = item.tool.toLowerCase();
  const target = truncate(summarizeValue(item.input));
  if (tool.includes("read") || tool.includes("open")) return `读取 ${target || item.tool}`;
  if (tool.includes("write") || tool.includes("edit") || tool.includes("patch")) {
    return `修改 ${target || item.tool}`;
  }
  if (tool.includes("command") || tool.includes("exec") || tool.includes("shell")) {
    return `执行 ${target || item.tool}`;
  }
  return target ? `${item.tool} ${target}` : item.tool;
}

export function StreamItem({ item }: { item: CliStreamItem }) {
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
          <summary>思考过程</summary>
          <MarkdownText content={item.content} />
        </details>
      );
    case "tool-call":
      return (
        <div className="stream-step stream-tool-call">
          <span className="stream-step-icon">⌁</span>
          <span>{toolActionLabel(item)}</span>
        </div>
      );
    case "tool-result":
      return (
        <details className={`stream-tool-result${item.isError ? " error" : ""}`}>
          <summary>
            <span className="stream-label">{item.tool} 结果</span>
            {item.isError && <span className="stream-error-suffix">error</span>}
          </summary>
          <pre>{item.content}</pre>
        </details>
      );
    case "command":
      return (
        <div className="stream-command">
          <span className="stream-label">⟩ Terminal</span>
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
          <span className="stream-label">Session</span>{" "}
          <code>{item.sessionId}</code>
          {item.title ? ` — ${item.title}` : ""}
        </div>
      );
    case "usage":
      return (
        <div className="stream-meta">
          <span className="stream-label">Usage</span>
          <span>in: {item.inputTokens ?? "–"} · out: {item.outputTokens ?? "–"}</span>
          {item.totalCost != null && (
            <span className="stream-cost"> · ${item.totalCost.toFixed(4)}</span>
          )}
        </div>
      );
    case "error":
      return (
        <div className="stream-error">
          <div>
            <span className="stream-label">Error</span> {item.message}
          </div>
          {item.details?.length ? (
            <details className="stream-error-details">
              <summary>查看原始日志 ({item.details.length})</summary>
              <pre>{item.details.join("\n")}</pre>
            </details>
          ) : null}
        </div>
      );
    case "done":
      return (
        <div className={`stream-meta done${item.exitCode && item.exitCode !== 0 ? " failed" : ""}`}>
          <span className="stream-label">
            {item.exitCode && item.exitCode !== 0 ? "Exit" : "✓ Done"}
          </span>
          {item.exitCode != null && <span> (exit {item.exitCode})</span>}
        </div>
      );
    case "raw":
      return <pre className="stream-raw">{item.content}</pre>;
    default:
      return null;
  }
}
