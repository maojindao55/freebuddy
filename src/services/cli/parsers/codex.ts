import {
  registerParser,
  tryJson,
  type AdapterStreamParser,
  type CliStreamItem
} from "../streamParser";

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
          message: String(msg.message ?? msg.error ?? line)
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
  }
};

registerParser("codex-json", codexParser);

export default codexParser;
