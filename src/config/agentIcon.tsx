import type { CLIAdapterId } from "@/config/cliAdapters";
import { parseLobehubAvatar } from "@/utils/lobehubAvatar";

const defaultAgentIcon: Partial<Record<CLIAdapterId, string>> = {
  "codex-acp": "OpenAI",
  codex: "OpenAI",
  "claude-agent-acp": "Claude",
  claude: "Claude",
  "opencode-acp": "OpenCode",
  opencode: "OpenCode",
  "cursor-agent-acp": "Cursor",
  "kimi-acp": "Kimi"
};

/**
 * Resolve the LobeHub icon id for an agent.
 * Priority: explicit override (`lobehub:<id>` or bare id) → adapter default.
 */
export function getAgentIconId(
  adapter?: string,
  overrideIcon?: string
): string | null {
  if (overrideIcon) {
    const parsed = parseLobehubAvatar(overrideIcon);
    if (parsed) return parsed;
    return overrideIcon;
  }
  if (!adapter) return null;
  return defaultAgentIcon[adapter as CLIAdapterId] ?? null;
}
