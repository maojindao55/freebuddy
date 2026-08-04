/** Pure builder for the environment.json included in debug log exports. */

export interface EnvironmentInfoInput {
  appVersion: string;
  platform: string;
  arch: string;
  osRelease: string;
  locale: string;
  versions: { electron?: string; chrome?: string; node?: string };
  telemetryEnabled: boolean;
  adapters: Array<{ id: string; label?: string }>;
  conversationCount: number;
  droppedLines: number;
  exportedAt: string;
  exportMode: "standard" | "full";
  exportScope: "conversation" | "all";
}

export function buildEnvironmentInfo(
  input: EnvironmentInfoInput
): Record<string, unknown> {
  return {
    app: {
      version: input.appVersion,
      platform: input.platform,
      arch: input.arch,
      osRelease: input.osRelease,
      locale: input.locale
    },
    runtime: {
      electron: input.versions.electron ?? "",
      chrome: input.versions.chrome ?? "",
      node: input.versions.node ?? ""
    },
    telemetry: { enabled: input.telemetryEnabled },
    adapters: input.adapters.map((a) => ({ id: a.id, label: a.label ?? a.id })),
    counts: { conversations: input.conversationCount },
    logHealth: { droppedLines: input.droppedLines },
    exportedAt: input.exportedAt,
    exportMode: input.exportMode,
    exportScope: input.exportScope
  };
}
