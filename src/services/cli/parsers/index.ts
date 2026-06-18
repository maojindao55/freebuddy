// Side-effect imports register each parser into the streamParser registry.
import "./codex";
import "./claude";
import "./opencode";

export { getParser } from "../streamParser";
export type { CliStreamItem, ParseContext } from "../streamParser";
