import type { CliStreamItem } from "@/services/cli/parsers";

export function StreamItem({ item }: { item: CliStreamItem }) {
  switch (item.kind) {
    case "text":
      return (
        <div className={`stream-text role-${item.role}`}>
          <pre>{item.content}</pre>
        </div>
      );
    case "thinking":
      return (
        <details className="stream-thinking">
          <summary>thinking</summary>
          <pre>{item.content}</pre>
        </details>
      );
    case "tool-call":
      return (
        <div className="stream-tool-call">
          <strong>→ {item.tool}</strong>
          {item.input != null && (
            <pre>
              {typeof item.input === "string"
                ? item.input
                : JSON.stringify(item.input, null, 2)}
            </pre>
          )}
        </div>
      );
    case "tool-result":
      return (
        <details className={`stream-tool-result${item.isError ? " error" : ""}`}>
          <summary>
            ← {item.tool}
            {item.isError ? " (error)" : ""}
          </summary>
          <pre>{item.content}</pre>
        </details>
      );
    case "command":
      return (
        <div className="stream-command">
          <strong>$ {item.command}</strong>
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
          <summary>
            {item.action} {item.path}
          </summary>
          {item.patch && <pre>{item.patch}</pre>}
        </details>
      );
    case "session":
      return (
        <div className="stream-meta">
          session: <code>{item.sessionId}</code>
          {item.title ? ` — ${item.title}` : ""}
        </div>
      );
    case "usage":
      return (
        <div className="stream-meta">
          usage: in={item.inputTokens ?? "-"} out={item.outputTokens ?? "-"}
          {item.totalCost != null ? ` $${item.totalCost.toFixed(4)}` : ""}
        </div>
      );
    case "error":
      return <div className="stream-error">! {item.message}</div>;
    case "done":
      return (
        <div className="stream-meta done">
          done{item.exitCode != null ? ` (exit ${item.exitCode})` : ""}
        </div>
      );
    case "raw":
      return <pre className="stream-raw">{item.content}</pre>;
    default:
      return null;
  }
}
