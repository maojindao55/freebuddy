import "./parsers/codex.js";
import "./parsers/claude.js";
import "./parsers/opencode.js";

export {
  appendItems,
  dedupeCommands,
  dedupeToolResults,
  MAX_MERGED_ASSISTANT_CHARS,
  MAX_MERGED_OUTPUT_CHARS,
  mergeToolCalls,
  plainAssistantText
} from "./accumulator.js";

export {
  getParser,
  rawParser,
  registerParser,
  tryJson,
  type AdapterStreamParser
} from "./streamParser.js";
export type {
  CLIStreamMode,
  CliStreamItem,
  ParseContext,
  ToolCallStatus,
  ToolKind,
  ToolOutputItem
} from "./streamParser.js";
