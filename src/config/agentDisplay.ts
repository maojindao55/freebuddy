import { getAdapter } from "./cliAdapters";

const legacyNameMap: Record<string, string> = {
  "Codex ACP": "Codex",
  "Codex Legacy": "Codex",
  "Claude Agent ACP": "ClaudeCode",
  "Claude Code Legacy": "ClaudeCode",
  "OpenCode ACP": "OpenCode",
  "OpenCode Legacy": "OpenCode"
};

export function displayAgentName(
  agentName: string | undefined,
  adapter?: string
) {
  const adapterLabel = adapter ? getAdapter(adapter)?.label : undefined;
  if (agentName) {
    const normalized =
      legacyNameMap[agentName] ?? agentName.replace(/\s+(ACP|Legacy)\b/g, "");
    if (!adapterLabel || normalized !== adapterLabel) return normalized;
  }
  return adapterLabel ?? "Agent";
}
