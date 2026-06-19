const ACTION_KEYS: Record<string, string> = {
  external_directory: "permission.action.externalDirectory",
  edit: "permission.action.edit",
  file_edit: "permission.action.edit",
  command: "permission.action.command",
  execute: "permission.action.command",
  bash: "permission.action.command",
  shell: "permission.action.command",
  fetch: "permission.action.fetch",
  web_fetch: "permission.action.fetch",
  web_search: "permission.action.search",
  read: "permission.action.read"
};

export function actionKeyFor(
  title: string | undefined,
  kind: string | undefined
): string | null {
  const t = String(title ?? "").toLowerCase();
  const k = String(kind ?? "").toLowerCase();
  if (t && ACTION_KEYS[t]) return ACTION_KEYS[t];
  if (k && ACTION_KEYS[k]) return ACTION_KEYS[k];
  return null;
}

export interface PermissionToolCall {
  locations?: unknown;
  rawInput?: unknown;
}

export function permissionTargets(toolCall: PermissionToolCall | undefined): string[] {
  if (!toolCall) return [];
  const locations = toolCall.locations;
  if (Array.isArray(locations)) {
    const paths = locations
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { path?: unknown }).path === "string"
          ? (entry as { path: string }).path
          : null
      )
      .filter((p): p is string => Boolean(p));
    if (paths.length) return [...new Set(paths)];
  }
  const raw = toolCall.rawInput as Record<string, unknown> | undefined;
  if (raw && typeof raw === "object") {
    const candidates = [raw.filepath, raw.path, raw.parentDir, raw.command, raw.cwd]
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (candidates.length) return [...new Set(candidates)];
  }
  return [];
}

export function optionKeyFor(kind: string | undefined): string | null {
  const k = String(kind ?? "").toLowerCase();
  if (k === "allow_once" || k.startsWith("allow_once")) return "permission.allowOnce";
  if (k === "allow_always" || k.startsWith("allow_always")) return "permission.allowAlways";
  if (k.startsWith("reject") || k === "deny") return "permission.reject";
  return null;
}
