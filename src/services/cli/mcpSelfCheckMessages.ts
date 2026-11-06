import type { TFunction } from "i18next";

const ERROR_KEYS: Record<string, string> = {
  cwd_required: "mcpServers.error.cwdRequired",
  startup_timeout: "mcpServers.error.startupTimeout",
  tools_timeout: "mcpServers.error.toolsTimeout"
};

export function mcpSelfCheckErrorMessage(
  result: { code?: string; error?: string },
  t: TFunction
): string {
  const key = result.code ? ERROR_KEYS[result.code] : undefined;
  if (key) return t(key);
  // Existing installations may still display a result from the old 15s check.
  if (result.error === "Self-check timed out") return t("mcpServers.error.checkTimeout");
  return result.error || t("mcpServers.error.selfCheckFailed");
}
