import fs from "node:fs";
import path from "node:path";

import type { SkillMarketProviderId, SkillRecord, SkillSource } from "./skillTypes.js";
import { MARKET_CONFIRMATION_PREFIX } from "./skillTypes.js";

type RmSync = typeof fs.rmSync;

/**
 * Best-effort cleanup after a durable commit. Failures are logged and swallowed so
 * they cannot trigger file rollback against an already-committed database row.
 */
export function removePathBestEffort(
  targetPath: string,
  options?: { rmSync?: RmSync; warn?: (message: string, error: unknown) => void }
): boolean {
  if (!targetPath || !fs.existsSync(targetPath)) return true;
  const rmSync = options?.rmSync ?? fs.rmSync;
  const warn =
    options?.warn ??
    ((message: string, error: unknown) => {
      console.warn(message, error);
    });
  try {
    rmSync(targetPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    warn(`[skills] failed to remove path ${targetPath}:`, error);
    return false;
  }
}

export function shouldRollbackSkillInstallFiles(databaseCommitted: boolean): boolean {
  return !databaseCommitted;
}

export function findExistingSkillForInstall(args: {
  packageName: string;
  source: SkillSource;
  market?: { provider: SkillMarketProviderId; marketSkillId: string };
  getById: (id: string) => SkillRecord | undefined;
  getByMarket: (
    provider: SkillMarketProviderId,
    marketSkillId: string
  ) => SkillRecord | undefined;
}): SkillRecord | undefined {
  if (args.source === "market" && args.market) {
    const byMarket = args.getByMarket(args.market.provider, args.market.marketSkillId);
    if (byMarket) return byMarket;
  }
  return args.getById(args.packageName);
}

/**
 * Returns true when the on-disk skill no longer matches the recorded contentHash.
 * `diskContentHash` is `null` when the directory exists but cannot be inspected.
 */
export function hasLocalSkillDrift(args: {
  existing?: SkillRecord;
  source: SkillSource;
  allowLocalOverwrite?: boolean;
  diskContentHash?: string | null;
}): boolean {
  if (args.allowLocalOverwrite) return false;
  if (args.source !== "market" || args.existing?.source !== "market") return false;
  if (args.diskContentHash === undefined) return false;
  return args.diskContentHash !== args.existing.contentHash;
}

export function localDriftConfirmationError(
  detail = "Local changes were detected in this installed skill. Confirm to overwrite them."
): Error {
  return new Error(`${MARKET_CONFIRMATION_PREFIX}:local-drift:${detail}`);
}

/** True when destination is the same install directory being replaced in-place. */
export function isInPlaceSkillDestination(
  destination: string,
  previousRoot?: string
): boolean {
  if (!previousRoot) return false;
  return path.resolve(destination) === path.resolve(previousRoot);
}

/**
 * Reject colliding destination directories before moving the existing install aside.
 * In-place updates (destination === previousRoot) are allowed.
 */
export function assertDestinationReadyForInstall(args: {
  destination: string;
  previousRoot?: string;
  destinationExists: boolean;
}): void {
  if (!args.destinationExists) return;
  if (isInPlaceSkillDestination(args.destination, args.previousRoot)) return;
  throw new Error(
    `Skill directory already exists at ${args.destination}; remove it before installing`
  );
}

export function rewriteSkillIdList(
  skillIds: string[] | undefined,
  fromId: string,
  toId: string
): string[] | undefined {
  if (!skillIds || fromId === toId) return skillIds;
  let changed = false;
  const next = skillIds.map((id) => {
    if (id !== fromId) return id;
    changed = true;
    return toId;
  });
  // Deduplicate while preserving order after a rename collision with an existing id.
  if (!changed) return skillIds;
  const seen = new Set<string>();
  return next.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function rewriteSkillIdListJson(
  skillIdsJson: string | null | undefined,
  fromId: string,
  toId: string
): string | null | undefined {
  if (skillIdsJson == null || skillIdsJson === "" || fromId === toId) {
    return skillIdsJson;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(skillIdsJson);
  } catch {
    return skillIdsJson;
  }
  if (!Array.isArray(parsed)) return skillIdsJson;
  const ids = parsed.filter((value): value is string => typeof value === "string");
  const next = rewriteSkillIdList(ids, fromId, toId) ?? ids;
  return JSON.stringify(next);
}

export function rewriteWorkflowRolesSkillIdsJson(
  rolesJson: string,
  fromId: string,
  toId: string
): string {
  if (!rolesJson || fromId === toId) return rolesJson;
  let roles: unknown;
  try {
    roles = JSON.parse(rolesJson);
  } catch {
    return rolesJson;
  }
  if (!Array.isArray(roles)) return rolesJson;
  let changed = false;
  const next = roles.map((role) => {
    if (!role || typeof role !== "object") return role;
    const record = role as { skillIds?: unknown };
    if (!Array.isArray(record.skillIds)) return role;
    const ids = record.skillIds.filter((value): value is string => typeof value === "string");
    const rewritten = rewriteSkillIdList(ids, fromId, toId) ?? ids;
    if (rewritten === ids) return role;
    changed = true;
    return { ...record, skillIds: rewritten };
  });
  return changed ? JSON.stringify(next) : rolesJson;
}
