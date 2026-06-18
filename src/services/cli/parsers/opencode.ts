import {
  registerParser,
  tryJson,
  type AdapterStreamParser,
  type ParseContext,
  type CliStreamItem
} from "../streamParser";

function rememberDiagnostic(ctx: ParseContext, line: string) {
  const trimmed = line.trim();
  if (!trimmed) return;
  const logs = ctx.diagnosticLogs ?? [];
  logs.push(trimmed);
  ctx.diagnosticLogs = logs.slice(-40);
}

function logfmtValue(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`${key}=("([^"]*)"|\\S+)`));
  if (!match) return undefined;
  return match[2] ?? match[1]?.replace(/^"|"$/g, "");
}

function isOpenCodeRuntimeLog(line: string) {
  return /\btimestamp=/.test(line) && /\blevel=/.test(line);
}

const opencodeParser: AdapterStreamParser = {
  parseStdoutLine(line, ctx) {
    if (isOpenCodeRuntimeLog(line)) {
      rememberDiagnostic(ctx, line);
      return [];
    }

    const obj = tryJson(line);
    if (!obj) return line ? [{ kind: "raw", content: line }] : [];
    const out: CliStreamItem[] = [];

    const sid = obj.session?.id ?? obj.sessionID ?? obj.session_id;
    if (sid && sid !== ctx.sessionId) {
      ctx.sessionId = sid;
      out.push({
        kind: "session",
        sessionId: sid,
        title: obj.session?.title
      });
    }

    const type: string = obj.type ?? obj.event ?? "";
    switch (type) {
      case "message.text":
      case "text":
        if (obj.text || obj.content) {
          out.push({
            kind: "text",
            role: obj.role === "user" ? "user" : "assistant",
            content: String(obj.text ?? obj.content ?? "")
          });
        }
        break;
      case "message.text.delta":
        if (obj.delta) {
          out.push({
            kind: "text",
            role: "assistant",
            content: String(obj.delta),
            append: true
          });
        }
        break;
      case "tool.start":
      case "tool.call":
        out.push({
          kind: "tool-call",
          tool: String(obj.tool ?? obj.name ?? "tool"),
          input: obj.input ?? obj.args,
          id: obj.id
        });
        break;
      case "tool.result":
      case "tool.end":
        out.push({
          kind: "tool-result",
          tool: String(obj.tool ?? obj.name ?? "tool"),
          id: obj.id,
          content: String(obj.output ?? obj.result ?? ""),
          isError: obj.error === true
        });
        break;
      case "file.edit":
        if (obj.path) {
          out.push({
            kind: "file-edit",
            path: String(obj.path),
            action: obj.action ?? "update",
            patch: obj.patch ?? obj.diff
          });
        }
        break;
      case "command":
        out.push({
          kind: "command",
          command: String(obj.command ?? ""),
          cwd: obj.cwd
        });
        break;
      case "command.output":
        out.push({
          kind: "command-output",
          content: String(obj.output ?? ""),
          stream: obj.stream === "stderr" ? "stderr" : "stdout"
        });
        break;
      case "usage":
        out.push({
          kind: "usage",
          inputTokens: obj.input_tokens,
          outputTokens: obj.output_tokens,
          totalCost: obj.cost
        });
        break;
      case "error":
        out.push({ kind: "error", message: String(obj.message ?? line) });
        break;
      case "done":
      case "complete":
        out.push({ kind: "done" });
        break;
      default:
        out.push({ kind: "raw", content: line });
    }
    return out;
  },
  parseStderrLine(line, ctx) {
    if (!line.trim()) return [];

    if (isOpenCodeRuntimeLog(line)) {
      rememberDiagnostic(ctx, line);
      const level = logfmtValue(line, "level")?.toUpperCase();
      if (level === "ERROR" || level === "FATAL" || level === "PANIC") {
        return [
          {
            kind: "error",
            message: logfmtValue(line, "message") ?? line,
            details: ctx.diagnosticLogs
          }
        ];
      }
      return [];
    }

    rememberDiagnostic(ctx, line);
    return [];
  }
};

registerParser("opencode-json", opencodeParser);

export default opencodeParser;
