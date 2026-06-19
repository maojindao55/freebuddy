import { getLobeIconCDN } from "@lobehub/icons";

const LOBEHUB_AVATAR_PREFIX = "lobehub:";

export function isLobehubAvatar(value?: string | null): boolean {
  return !!value?.startsWith(LOBEHUB_AVATAR_PREFIX);
}

export function encodeLobehubAvatar(iconId: string): string {
  return `${LOBEHUB_AVATAR_PREFIX}${iconId}`;
}

export function parseLobehubAvatar(value?: string | null): string | null {
  if (!isLobehubAvatar(value)) return null;
  const id = value!.slice(LOBEHUB_AVATAR_PREFIX.length);
  return id || null;
}

export function lobehubAvatarUrl(iconId: string): string {
  return getLobeIconCDN(iconId, { format: "avatar", cdn: "aliyun" });
}

/** Resolve a stored avatar value (lobehub:<id> or bare id) to a renderable CDN url. */
export function resolveLobehubAvatarUrl(value?: string | null): string | undefined {
  if (!value) return undefined;
  const id = parseLobehubAvatar(value) ?? value;
  return lobehubAvatarUrl(id);
}
