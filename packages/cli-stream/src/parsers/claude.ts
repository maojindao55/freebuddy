import {
  registerParser,
  tryJson,
  type AdapterStreamParser,
  type CliStreamItem
} from "../streamParser.js";

const claudeParser: AdapterStreamParser = {
  parseStdoutLine(line, ctx) {
    const obj = tryJson(line);
    if (!obj) return line ? [{ kind: "raw", content: line }] : [];

    const out: CliStreamItem[] = [];
    if (obj.session_id && obj.session_id !== ctx.sessionId) {
      ctx.sessionId = obj.session_id;
      out.push({ kind: "session", sessionId: obj.session_id });
    }

    const type: string = obj.type;
    switch (type) {
      case "system":
      case "rate_limit_event":
        break;
      case "stream_event": {
        const event = obj.event;
        if (event?.type === "message_start") {
          ctx.streamMessageId = typeof event.message?.id === "string" ? event.message.id : undefined;
        } else if (ctx.streamMessageId && event?.type === "content_block_delta") {
          const messageId = `${ctx.streamMessageId}:${event.index}`;
          if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
            out.push({ kind: "text", role: "assistant", content: event.delta.text, append: true, messageId });
          } else if (event.delta?.type === "thinking_delta" && typeof event.delta.thinking === "string") {
            out.push({ kind: "thinking", content: event.delta.thinking, append: true, messageId });
          }
        }
        break;
      }
      case "assistant": {
        const blocks = Array.isArray(obj.message?.content) ? obj.message.content : [];
        for (const [index, b] of blocks.entries()) {
          const identity = typeof obj.message?.id === "string" ? { messageId: `${obj.message.id}:${index}` } : {};
          if (b.type === "text" && b.text) {
            out.push({ kind: "text", role: "assistant", content: b.text, ...identity });
          } else if (b.type === "thinking" && b.thinking) {
            out.push({ kind: "thinking", content: b.thinking, ...identity });
          } else if (b.type === "tool_use") {
            out.push({
              kind: "tool-call",
              tool: String(b.name ?? "tool"),
              input: b.input,
              id: b.id
            });
          }
        }
        break;
      }
      case "user": {
        const blocks = obj.message?.content ?? [];
        for (const b of blocks) {
          if (b.type === "tool_result") {
            const content = Array.isArray(b.content)
              ? b.content
                  .map((c: any) => (typeof c === "string" ? c : c.text ?? ""))
                  .join("\n")
              : String(b.content ?? "");
            out.push({
              kind: "tool-result",
              tool: "tool",
              id: b.tool_use_id,
              content,
              isError: b.is_error === true
            });
          }
        }
        break;
      }
      case "result":
        out.push({
          kind: "usage",
          usageScope: "turn",
          inputTokens: obj.usage?.input_tokens,
          outputTokens: obj.usage?.output_tokens,
          totalCost: obj.total_cost_usd
        });
        out.push({ kind: "done" });
        break;
      default:
        out.push({ kind: "raw", content: line });
    }
    return out;
  }
};

registerParser("claude-json", claudeParser);

export default claudeParser;
