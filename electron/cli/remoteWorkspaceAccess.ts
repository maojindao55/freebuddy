import { getCallerUserId, isCallerAdmin } from "./callerContext.js";
import { remoteSourceRootsForUser } from "./remoteRoots.js";
import { ensureRemoteWorkspace } from "./remoteWorkspaces.js";

export async function isolateRemoteCwdForCaller(
  cwd: string | undefined
): Promise<string | undefined> {
  const caller = getCallerUserId();
  if (!cwd || !caller || isCallerAdmin()) return cwd;
  return ensureRemoteWorkspace(caller, cwd, remoteSourceRootsForUser(caller));
}
