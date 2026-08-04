import os from "node:os";

import { getUserById, getUserRoots } from "./users.js";
import { listRemoteWorkspacePaths } from "./remoteWorkspaces.js";
import { resolveWorkspaceRoots } from "../shared/workspaceRoots.js";

/**
 * Directories a caller may reach over the remote bridge.
 *
 * `resolveWorkspaceRoots([])` falls back to the host home directory. That is
 * the historical desktop behaviour and stays correct for the owner, but for a
 * member it would mean "no directories assigned" silently grants the whole
 * home folder — the opposite of what the admin configured. Members therefore
 * get an empty set until the owner assigns roots to them.
 *
 * The owner always keeps home access in addition to any configured roots, so
 * absolute paths under the account home (e.g. generated images) remain
 * previewable on WebUI the same way desktop `freebuddy-file://` allows them.
 */
export function remoteSourceRootsForUser(
  userId: string | null | undefined
): string[] {
  if (!userId) return resolveWorkspaceRoots([]);
  const roots = getUserRoots(userId);
  const isOwner = getUserById(userId)?.isOwner === true;
  if (roots.length > 0) {
    const resolved = resolveWorkspaceRoots(roots);
    return isOwner
      ? resolveWorkspaceRoots([...resolved, os.homedir()])
      : resolved;
  }
  return isOwner ? resolveWorkspaceRoots([]) : [];
}

/**
 * All paths a remote caller may use after the source repository has been
 * materialized. Managed per-user clones are deliberately not shown by the
 * directory picker, but must remain reachable for runs, attachments and
 * previews belonging to existing conversations.
 */
export function remoteRootsForUser(userId: string | null | undefined): string[] {
  const sources = remoteSourceRootsForUser(userId);
  if (!userId) return sources;
  const combined = [...sources, ...listRemoteWorkspacePaths(userId)];
  return combined.length > 0 ? resolveWorkspaceRoots(combined) : [];
}

/** True when the user browses the host home directory by default. */
export function usesDefaultHomeRoots(userId: string | null | undefined): boolean {
  if (!userId) return true;
  if (getUserRoots(userId).length > 0) return false;
  return getUserById(userId)?.isOwner === true;
}
