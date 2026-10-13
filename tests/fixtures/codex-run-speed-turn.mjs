// Reduced timing trace from the 2026-10-13 Codex ACP 2.2.2 self-check. Content
// and paths are replaced; timestamps, tool boundaries and usage stay intact.
const thought = text => ({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } });
const body = text => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const tool = (id, status, kind = "edit") => ({ sessionUpdate: status === "in_progress" ? "tool_call" : "tool_call_update", toolCallId: id, status, kind });
export const codexSpeedUpdates = [
  [4651, thought("\n\n")], [4651, thought("first reasoning summary")],
  [4677, body("first")], [4717, body("response")], [5283, tool("read", "in_progress", "read")], [5284, tool("read", "completed", "read")],
  [7386, thought("edit reasoning")], [8342, thought("edit summary")], [8442, tool("edit-1", "in_progress")], [8485, tool("edit-1", "completed")],
  [9634, tool("edit-2", "in_progress")], [9655, tool("edit-2", "completed")],
  [10827, tool("edit-3", "in_progress")], [10853, tool("edit-3", "completed")],
  [14815, thought("check reasoning")], [15544, body("checking")], [15654, body("diff")],
  [16340, tool("check", "in_progress", "execute")], [16340, tool("check", "failed", "execute")],
  [18132, thought("single condensed summary")], [18244, tool("final-read", "in_progress", "read")], [18245, tool("final-read", "completed", "read")],
  [20956, thought("final reasoning")], [21028, body("final")], [21811, body("answer")]
];
export const codexSpeedResult = { stopReason: "end_turn", usage: {
  totalTokens: 149464, inputTokens: 19173, cachedReadTokens: 129280, cachedWriteTokens: 0, outputTokens: 1011, thoughtTokens: 431
} };
