export const AGENT_LANGUAGE_HEADER = "FreeBuddy response language:";

export function resolveAgentOutputLanguage(
  language: string | null | undefined
): "Simplified Chinese" | "English" {
  return language === "zh-CN" ? "Simplified Chinese" : "English";
}

/** Prepend a stable language preference so agents match the app locale. */
export function applyAgentLanguagePreference(
  prompt: string,
  language: string | null | undefined
): string {
  if (
    prompt.startsWith(AGENT_LANGUAGE_HEADER) ||
    prompt.startsWith("FreeBuddy workflow response language:")
  ) {
    return prompt;
  }
  const outputLanguage = resolveAgentOutputLanguage(language);
  return [
    `${AGENT_LANGUAGE_HEADER} Write all user-facing prose in ${outputLanguage}.`,
    "Keep code, file paths, commands, logs, and identifiers exactly as written.",
    "",
    prompt
  ].join("\n");
}
