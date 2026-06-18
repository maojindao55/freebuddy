import {
  registerParser,
  tryJson,
  type AdapterStreamParser,
  type CliStreamItem
} from "../streamParser";

function errorMessageFrom(value: any, fallback: string): string {
  const err = value?.error;
  if (typeof err === "string") return err;
  if (err?.message) return String(err.message);
  if (value?.message) return String(value.message);
  return fallback;
}

const codexParser: AdapterStreamParser = {
  parseStdoutLine(line, ctx) {
    const obj = tryJson(line);
    if (!obj) return line ? [{ kind: "raw", content: line }] : [];

    const out: CliStreamItem[] = [];
    const msg = obj.msg ?? obj;
    const type: string = msg.type ?? obj.type ?? "";

    const sid =
      obj.session_id || obj.sessionId || msg.session_id || msg.sessionId;
    if (sid && sid !== ctx.sessionId) {
      ctx.sessionId = sid;
      out.push({ kind: "session", sessionId: sid });
    }

    switch (type) {
      case "thread.started": {
        const threadId = msg.thread_id ?? msg.threadId;
        if (threadId && threadId !== ctx.sessionId) {
          ctx.sessionId = String(threadId);
          out.push({ kind: "session", sessionId: String(threadId) });
        }
        break;
      }
      case "turn.started":
        break;
      case "item.updated": {
        const item = msg.item ?? {};
        const itemType = String(item.type ?? "");
        const delta =
          msg.delta ??
          item.delta ??
          item.text_delta ??
          item.content_delta ??
          item.thinking_delta;

        if (
          (itemType === "agent_message" || itemType === "assistant_message") &&
          delta
        ) {
          out.push({
            kind: "text",
            role: "assistant",
            content: String(delta),
            append: true
          });
        } else if (itemType === "reasoning" && delta) {
          out.push({
            kind: "thinking",
            content: String(delta),
            append: true
          });
        }
        break;
      }
      case "item.completed": {
        const item = msg.item ?? {};
        const itemType = String(item.type ?? "");
        if (itemType === "agent_message" || itemType === "assistant_message") {
          const text = item.text ?? item.message ?? item.content;
          if (text) {
            out.push({
              kind: "text",
              role: "assistant",
              content: String(text)
            });
          }
        } else if (itemType === "reasoning") {
          const text = item.text ?? item.content;
          if (text) out.push({ kind: "thinking", content: String(text) });
        } else if (itemType === "function_call" || itemType === "tool_call") {
          out.push({
            kind: "tool-call",
            tool: String(item.name ?? item.tool ?? "tool"),
            input: item.arguments ?? item.input,
            id: item.id
          });
        } else if (itemType === "function_call_output" || itemType === "tool_result") {
          out.push({
            kind: "tool-result",
            tool: String(item.name ?? item.tool ?? "tool"),
            id: item.id,
            content: String(item.output ?? item.content ?? ""),
            isError: item.is_error === true
          });
        }
        break;
      }
      case "turn.completed": {
        const usage = msg.usage ?? {};
        if (Object.keys(usage).length > 0) {
          out.push({
            kind: "usage",
            inputTokens: usage.input_tokens ?? usage.inputTokens,
            outputTokens: usage.output_tokens ?? usage.outputTokens,
            totalCost: usage.total_cost ?? usage.totalCost
          });
        }
        break;
      }
      case "turn.failed":
      case "turn.error":
      case "turn.aborted":
      case "turn.cancelled":
        out.push({
          kind: "error",
          message: errorMessageFrom(msg, line)
        });
        break;
      case "agent_message":
      case "assistant_message":
      case "message":
        if (msg.message || msg.content) {
          out.push({
            kind: "text",
            role: "assistant",
            content: String(msg.message ?? msg.content ?? "")
          });
        }
        break;
      case "agent_message_delta":
        if (msg.delta) {
          out.push({
            kind: "text",
            role: "assistant",
            content: String(msg.delta),
            append: true
          });
        }
        break;
      case "agent_reasoning":
      case "reasoning":
        if (msg.text || msg.content) {
          out.push({
            kind: "thinking",
            content: String(msg.text ?? msg.content ?? "")
          });
        }
        break;
      case "agent_reasoning_delta":
        if (msg.delta) {
          out.push({
            kind: "thinking",
            content: String(msg.delta),
            append: true
          });
        }
        break;
      case "exec_command_begin":
      case "command":
        out.push({
          kind: "command",
          command: Array.isArray(msg.command)
            ? msg.command.join(" ")
            : String(msg.command ?? msg.cmd ?? ""),
          cwd: msg.cwd
        });
        break;
      case "exec_command_output_delta":
        if (msg.chunk) {
          out.push({
            kind: "command-output",
            content: String(msg.chunk),
            stream: msg.stream === "stderr" ? "stderr" : "stdout"
          });
        }
        break;
      case "exec_command_end":
        if (msg.exit_code != null) {
          out.push({
            kind: "command-output",
            content: `exit ${msg.exit_code}`,
            stream: "stdout"
          });
        }
        break;
      case "tool_use":
      case "function_call":
        out.push({
          kind: "tool-call",
          tool: String(msg.name ?? msg.tool ?? "tool"),
          input: msg.arguments ?? msg.input,
          id: msg.id
        });
        break;
      case "tool_result":
      case "function_call_output":
        out.push({
          kind: "tool-result",
          tool: String(msg.name ?? msg.tool ?? "tool"),
          id: msg.id,
          content: String(msg.output ?? msg.content ?? ""),
          isError: msg.is_error === true
        });
        break;
      case "patch_apply_begin":
      case "file_change":
        if (msg.path) {
          out.push({
            kind: "file-edit",
            path: String(msg.path),
            action: (msg.action as any) ?? "update",
            patch: msg.patch ?? msg.diff
          });
        }
        break;
      case "token_count":
      case "usage":
        out.push({
          kind: "usage",
          inputTokens: msg.input_tokens ?? msg.inputTokens,
          outputTokens: msg.output_tokens ?? msg.outputTokens,
          totalCost: msg.total_cost ?? msg.totalCost
        });
        break;
      case "error":
        out.push({
          kind: "error",
          message: errorMessageFrom(msg, line)
        });
        break;
      case "task_complete":
      case "agent_done":
        out.push({ kind: "done" });
        break;
      default:
        out.push({ kind: "raw", content: line });
    }
    return out;
  },
  parseStderrLine(line) {
    if (line.includes("Reading additional input from stdin")) return [];
    return line ? [{ kind: "command-output", content: line, stream: "stderr" }] : [];
  }
};

registerParser("codex-json", codexParser);

export default codexParser;
