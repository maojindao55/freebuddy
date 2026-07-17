/**
 * Existing skills keep their enabled flag.
 * Brand-new installs default to enabled only when trusted; untrusted market
 * packages start disabled so they cannot appear "on" while unusable.
 */
export function nextSkillEnabledFlag(
  existingEnabled: boolean | undefined,
  options?: { trusted?: boolean }
): number {
  if (existingEnabled !== undefined) {
    return existingEnabled ? 1 : 0;
  }
  if (options?.trusted === false) return 0;
  return 1;
}
