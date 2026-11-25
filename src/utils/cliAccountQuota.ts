import type { TFunction } from "i18next";
import type {
  CliAccountQuotaBucket,
  CliAccountQuotaSnapshot
} from "@/services/cli/types";

export interface CompactQuotaPill {
  key: string;
  label: string;
  leftPercent: number;
  status: "ok" | "warning" | "danger";
  stale: boolean;
}

export function formatAccountQuotaPercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(2);
}

export function formatAuthMethodLabel(
  authMethod: string | undefined,
  t: TFunction
): string | undefined {
  const normalized = authMethod?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "business" || normalized === "oauth-business") {
    return t("settings.cli.accounts.authMethodBusiness");
  }
  if (
    normalized === "consumer" ||
    normalized === "personal" ||
    normalized === "oauth-personal"
  ) {
    return t("settings.cli.accounts.authMethodPersonal");
  }
  return authMethod;
}

function compactBucketWindow(bucket: CliAccountQuotaBucket): string {
  if (bucket.window === "5h" || bucket.windowSeconds === 18_000) return "5h";
  if (bucket.window === "weekly" || bucket.windowSeconds === 604_800) {
    return "7d";
  }
  if (bucket.window === "daily" || bucket.windowSeconds === 86_400) {
    return "24h";
  }
  return bucket.window || "";
}

function compactGroupPrefix(displayName: string): string {
  if (displayName === "Gemini Models") return "Gemini";
  if (displayName === "Claude and GPT models") return "Claude/GPT";
  if (displayName.includes("Argon")) return "Argon";
  return displayName.split(/\s+/)[0] || "Model";
}

function quotaStatus(leftPercent: number): "ok" | "warning" | "danger" {
  if (leftPercent === 0) return "danger";
  if (leftPercent <= 20) return "warning";
  return "ok";
}

export function extractCompactAccountQuotaPills(
  snapshot: CliAccountQuotaSnapshot | undefined,
  maxPills = 3
): CompactQuotaPill[] {
  const groups = snapshot?.groups;
  if (!groups || groups.length === 0) return [];
  const stale = snapshot.ok === false;
  const pills: CompactQuotaPill[] = [];

  for (const group of groups) {
    const prefix = compactGroupPrefix(group.displayName);
    for (const bucket of group.buckets) {
      const win = compactBucketWindow(bucket);
      pills.push({
        key: `${group.displayName}:${bucket.bucketId || win}`,
        label: win ? `${prefix} ${win}` : prefix,
        leftPercent: bucket.leftPercent,
        status: quotaStatus(bucket.leftPercent),
        stale
      });
      if (pills.length >= maxPills) return pills;
    }
  }
  return pills;
}

export function primaryQuotaSummary(
  snapshot: CliAccountQuotaSnapshot | undefined
): { leftPercent: number; status: "ok" | "warning" | "danger"; stale: boolean } | undefined {
  const pills = extractCompactAccountQuotaPills(snapshot, 1);
  if (pills.length === 0) return undefined;
  return {
    leftPercent: pills[0].leftPercent,
    status: pills[0].status,
    stale: pills[0].stale
  };
}

/** Removes any legacy auto-saved suffix when displaying account labels. */
export function cleanCliAccountLabel(label: string): string {
  const cleaned = label.replace(/\s*\(auto-saved\)$/i, "").trim();
  return cleaned || label;
}

/**
 * Formats an account label for compact single-line headers, showing only the
 * email local-part unless another account in the list shares that prefix.
 */
export function compactCliAccountTriggerLabel(
  rawLabel: string,
  allAccounts: readonly { label: string; accountIdentity?: string }[]
): string {
  const cleaned = cleanCliAccountLabel(rawLabel);
  const atIndex = cleaned.indexOf("@");
  if (atIndex <= 0) return cleaned;

  const localPart = cleaned.slice(0, atIndex);
  const normalizedTarget = cleaned.toLowerCase();
  const normalizedLocal = localPart.toLowerCase();

  const hasLocalPartCollision = allAccounts.some((account) => {
    const candidates = [account.accountIdentity, cleanCliAccountLabel(account.label)];
    return candidates.some((candidate) => {
      if (!candidate) return false;
      const lower = candidate.trim().toLowerCase();
      const idx = lower.indexOf("@");
      return (
        idx > 0 &&
        lower !== normalizedTarget &&
        lower.slice(0, idx) === normalizedLocal
      );
    });
  });

  return hasLocalPartCollision ? cleaned : localPart;
}
