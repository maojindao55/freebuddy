export type PluginMentionSegment =
  | { kind: "text"; value: string }
  | { kind: "plugin"; value: string; name: string; uri: string };

const PLUGIN_MENTION_PATTERN = /\[@([A-Za-z0-9][A-Za-z0-9._-]*)\]\((plugin:\/\/[^\s)]+)\)/g;
const BROWSER_PLUGIN_PATTERN = /\[@browser\]\(plugin:\/\/browser@[^\s)]+\)/i;

const FREEBUDDY_BROWSER_COMPATIBILITY = `FreeBuddy plugin compatibility:
The requested Browser plugin is backed in this ACP session by the attached freebuddy-browser MCP server. Use browser_open with visible=true when the user explicitly asks to open or view a page, then use browser_inspect, browser_click, browser_type, browser_scroll, browser_extract, and browser_close as needed. Do not treat a missing Codex Desktop agent.browsers runtime as Browser unavailability, and do not switch to Chrome unless the FreeBuddy browser tools fail.`;

export function pluginDisplayName(name: string): string {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function splitPluginMentions(value: string): PluginMentionSegment[] {
  const segments: PluginMentionSegment[] = [];
  let textStart = 0;

  for (const match of value.matchAll(PLUGIN_MENTION_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    const name = match[1];
    const uri = match[2];
    if (textStart < start) {
      segments.push({ kind: "text", value: value.slice(textStart, start) });
    }
    segments.push({ kind: "plugin", value: raw, name, uri });
    textStart = start + raw.length;
  }

  if (textStart < value.length) {
    segments.push({ kind: "text", value: value.slice(textStart) });
  }
  return segments.length > 0 ? segments : [{ kind: "text", value }];
}

export function addPluginHostCompatibility(prompt: string, adapter?: string): string {
  const normalizedAdapter = adapter?.trim().toLocaleLowerCase() ?? "";
  if (
    !BROWSER_PLUGIN_PATTERN.test(prompt)
    || (!normalizedAdapter.startsWith("codex") && !normalizedAdapter.startsWith("claude"))
  ) {
    return prompt;
  }
  return `${prompt}\n\n${FREEBUDDY_BROWSER_COMPATIBILITY}`;
}
