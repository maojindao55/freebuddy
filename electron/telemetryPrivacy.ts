const KNOWN_ADAPTERS = new Set([
  "codex",
  "claude",
  "opencode",
  "codex-acp",
  "claude-agent-acp",
  "opencode-acp",
  "cursor-agent-acp",
  "kimi-acp",
  "qoder-acp",
  "codebuddy-acp",
  "grok-acp"
]);

export type TelemetryErrorCategory =
  | "binary_not_found"
  | "authentication_failed"
  | "permission_denied"
  | "protocol_error"
  | "network_error"
  | "process_failed"
  | "unknown";

export function normalizeTelemetryAdapter(adapter?: string): string {
  const normalized = adapter?.trim().toLowerCase();
  return normalized && KNOWN_ADAPTERS.has(normalized) ? normalized : "custom";
}

export function categorizeTelemetryError(value: unknown): TelemetryErrorCategory {
  const message = value instanceof Error ? value.message : String(value ?? "");
  const normalized = message.toLowerCase();
  if (/enoent|binary not found|not found/.test(normalized)) return "binary_not_found";
  if (/unauthorized|authentication|api key|\b401\b|\b403\b/.test(normalized)) {
    return "authentication_failed";
  }
  if (/permission|access denied|eperm|eacces/.test(normalized)) return "permission_denied";
  if (/json-rpc|protocol|\bacp\b/.test(normalized)) return "protocol_error";
  if (/network|fetch|timeout|timed out|econn|socket|dns/.test(normalized)) {
    return "network_error";
  }
  if (/exit|spawn|process|failed|failure/.test(normalized)) return "process_failed";
  return "unknown";
}

export function telemetryDurationMs(startedAt?: string, endedAt = Date.now()): number {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(started) ? Math.max(0, endedAt - started) : 0;
}
