export const ANTIGRAVITY_MINIMUM_VERSION = "1.5.9";

/** Explicit bridge executables remain supported during the native ACP migration. */
export function isAntigravityBridgeBinary(binary: string | undefined): boolean {
  const normalized = (binary ?? "").trim().replace(/\\/g, "/").toLowerCase();
  return /(?:^|\/)(?:agy-acp|agy-acp-bridge)(?:\.(?:exe|cmd|bat|ps1))?$/.test(normalized)
    || /\/agy-acp-bridge\/dist\/index\.js$/.test(normalized);
}

/** Translate persisted bridge controls without overriding an explicit native value. */
export function antigravityConfigOverrides(
  overrides: Record<string, string> | undefined,
  bridge = false
): Record<string, string> | undefined {
  if (!overrides) return undefined;
  const next = { ...overrides };
  const [from, to] = bridge ? ["thought_level", "effort"] : ["effort", "thought_level"];
  if (next[from] && !next[to]) next[to] = next[from];
  delete next[from];
  if (!bridge && next.model === "gpt-oss-120b") next.model = "gpt-oss-120b-medium";
  return next;
}
