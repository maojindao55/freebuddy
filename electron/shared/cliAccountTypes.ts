export type CliAccountStorageMode = "global-slot" | "isolated-dir";

export interface CliAccountQuotaBucket {
  bucketId: string;
  displayName: string;
  window: string;
  windowSeconds: number;
  remainingFraction: number;
  usedPercent: number;
  leftPercent: number;
  resetTime?: string;
  resetAt?: number;
  description?: string;
}

export interface CliAccountQuotaGroup {
  displayName: string;
  description?: string;
  buckets: CliAccountQuotaBucket[];
}

export type CliAccountQuotaSnapshot =
  | {
      ok: true;
      email?: string;
      planType?: string;
      groups: CliAccountQuotaGroup[];
      fetchedAt: string;
    }
  | {
      ok: false;
      reason:
        | "missing_auth"
        | "invalid_auth"
        | "expired_token"
        | "request_failed"
        | "invalid_response"
        | "unsupported_platform";
      error?: string;
      fetchedAt: string;
      /** Cached groups preserved when a refresh fails (e.g. expired_token). */
      groups?: CliAccountQuotaGroup[];
      /** Timestamp of the cached quota snapshot when groups are stale. */
      cachedFetchedAt?: string;
    };

export interface CliAgentAccount {
  id: string;
  adapter: string;
  label: string;
  accountIdentity?: string;
  authMethod?: string;
  storageMode: CliAccountStorageMode;
  profileDir?: string;
  isActive: boolean;
  quotaSnapshot?: CliAccountQuotaSnapshot;
  quotaUpdatedAt?: string;
  lastUsedAt?: string;
  lastSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DetectedSystemAccount {
  identity?: string;
  authMethod?: string;
  expired?: boolean;
}

export interface CliAgentSystemAccountState {
  adapter: string;
  supported: boolean;
  storageMode?: CliAccountStorageMode;
  supportsConcurrentProfiles: boolean;
  activeAccountId?: string;
  hasRunningTasks: boolean;
  detectedSystemAccount?: DetectedSystemAccount;
  externalAccountMismatch: boolean;
  accounts: CliAgentAccount[];
}

export interface CliAccountLoginInput {
  adapter: string;
  label?: string;
  binary?: string;
  env?: Record<string, string>;
  reloginAccountId?: string;
}

export interface CliAccountMutationResult {
  account: CliAgentAccount;
  state: CliAgentSystemAccountState;
}
