import { BrowserWindow } from "electron";
import { acpProcessPool } from "../acpProcessPool.js";
import { safeSendToWebContents } from "../ipcSend.js";
import { hasActiveRunsForAdapter as defaultHasActiveRunsForAdapter, type CliEvent } from "../runtimeShared.js";
import {
  bumpAccountRevision,
  getActiveAccountContext
} from "./accountContext.js";
import {
  createAccountRecord,
  decryptAccountCredential,
  deleteAccountRecord,
  findAccountByIdentity,
  getAccountRecord,
  getActiveAccountRecord,
  listAccountRecords,
  setActiveAccountInDb,
  toPublicAccount,
  updateAccountCredential,
  updateAccountLabel,
  updateAccountQuota,
  type CliAgentAccountRecord
} from "./accountStore.js";
import {
  createAgyAccountDriver,
  type CliAccountDriver,
  type DetectedCredential
} from "./agyAccountDriver.js";
import type {
  CliAccountLoginInput,
  CliAccountMutationResult,
  CliAccountQuotaSnapshot,
  CliAgentSystemAccountState
} from "../../shared/cliAccountTypes.js";

export { getActiveAccountContext } from "./accountContext.js";

export interface CliAccountManagerDeps {
  drivers?: Record<string, CliAccountDriver>;
  hasActiveRuns?: (adapter: string) => boolean;
  disposeWarmPool?: (adapter: string) => void;
  notifyChanged?: (adapter: string) => void;
}

function defaultNotifyChanged(adapter: string): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      safeSendToWebContents(win.webContents, "cli-accounts://changed", {
        adapter,
        at: Date.now()
      });
    }
  } catch {
    // Headless unit tests stub BrowserWindow or run without windows.
  }
}

function identitiesEqual(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function isSameManagedSlot(
  record: CliAgentAccountRecord,
  detected: DetectedCredential
): boolean {
  if (record.accountIdentity && detected.identity) {
    return identitiesEqual(record.accountIdentity, detected.identity);
  }
  if (!record.accountIdentity && !detected.identity) {
    return true;
  }
  return !record.accountIdentity;
}

export function createCliAccountManager(deps: CliAccountManagerDeps = {}) {
  const drivers = new Map<string, CliAccountDriver>(
    Object.entries(
      deps.drivers ?? {
        "agy-acp": createAgyAccountDriver()
      }
    )
  );
  const hasActiveRuns = deps.hasActiveRuns ?? defaultHasActiveRunsForAdapter;
  const disposeWarmPool =
    deps.disposeWarmPool ?? ((adapter: string) => acpProcessPool.disposeByAdapter(adapter));
  const notifyChanged = deps.notifyChanged ?? defaultNotifyChanged;

  const adapterQueues = new Map<string, Promise<unknown>>();
  const activeMutations = new Set<string>();

  function withAdapterLock<T>(adapter: string, fn: () => Promise<T>): Promise<T> {
    const previous = adapterQueues.get(adapter) ?? Promise.resolve();
    const run = previous.then(
      async () => {
        activeMutations.add(adapter);
        try {
          return await fn();
        } finally {
          activeMutations.delete(adapter);
        }
      },
      async () => {
        activeMutations.add(adapter);
        try {
          return await fn();
        } finally {
          activeMutations.delete(adapter);
        }
      }
    );
    const settled = run.catch(() => undefined);
    adapterQueues.set(adapter, settled);
    void settled.finally(() => {
      if (adapterQueues.get(adapter) === settled) {
        adapterQueues.delete(adapter);
      }
    });
    return run;
  }

  function buildState(
    adapter: string,
    driver: CliAccountDriver | undefined,
    detected: DetectedCredential | null
  ): CliAgentSystemAccountState {
    if (!driver) {
      return {
        adapter,
        supported: false,
        supportsConcurrentProfiles: false,
        hasRunningTasks: hasActiveRuns(adapter),
        externalAccountMismatch: false,
        accounts: []
      };
    }

    const records = listAccountRecords(adapter);
    const active = records.find((record) => record.isActive);
    const externalAccountMismatch = Boolean(
      detected &&
        (!active ||
          (active.accountIdentity &&
            detected.identity &&
            !identitiesEqual(active.accountIdentity, detected.identity)))
    );

    return {
      adapter,
      supported: true,
      storageMode: driver.storageMode,
      supportsConcurrentProfiles: driver.supportsConcurrentProfiles,
      ...(active ? { activeAccountId: active.id } : {}),
      hasRunningTasks: hasActiveRuns(adapter),
      ...(detected
        ? {
            detectedSystemAccount: {
              ...(detected.identity ? { identity: detected.identity } : {}),
              ...(detected.authMethod ? { authMethod: detected.authMethod } : {}),
              ...(detected.expired !== undefined ? { expired: detected.expired } : {})
            }
          }
        : {}),
      externalAccountMismatch,
      accounts: records.map(toPublicAccount)
    };
  }

  function syncDetectedCredentialToVault(
    adapter: string,
    detected: DetectedCredential | null,
    options: { allowAutoSaveUnmanaged?: boolean } = {}
  ): void {
    if (!detected) return;
    const active = getActiveAccountRecord(adapter);
    if (active && isSameManagedSlot(active, detected)) {
      updateAccountCredential(active.id, detected.rawSecret, {
        accountIdentity: detected.identity,
        authMethod: detected.authMethod
      });
      return;
    }

    const existingByIdentity = detected.identity
      ? findAccountByIdentity(adapter, detected.identity)
      : undefined;
    if (existingByIdentity) {
      updateAccountCredential(existingByIdentity.id, detected.rawSecret, {
        accountIdentity: detected.identity,
        authMethod: detected.authMethod
      });
      return;
    }

    if (options.allowAutoSaveUnmanaged) {
      const driver = drivers.get(adapter);
      if (!driver) return;
      const baseName = detected.identity || "Antigravity";
      createAccountRecord({
        adapter,
        label: `${baseName} (auto-saved)`,
        accountIdentity: detected.identity,
        authMethod: detected.authMethod,
        storageMode: driver.storageMode,
        rawSecret: detected.rawSecret,
        isActive: false
      });
    }
  }

  async function bestEffortRefreshSingleQuota(
    driver: CliAccountDriver,
    record: CliAgentAccountRecord,
    rawSecret: string
  ): Promise<void> {
    if (!driver.readUsageForSecret) return;
    try {
      const snapshot = await driver.readUsageForSecret(rawSecret);
      updateAccountQuota(record.id, snapshot);
    } catch {
      // Best-effort quota sync should not fail account import/login/switch.
    }
  }

  async function getAccountsState(
    adapter: string
  ): Promise<CliAgentSystemAccountState> {
    const driver = drivers.get(adapter);
    if (!driver) {
      return buildState(adapter, undefined, null);
    }

    let detected: DetectedCredential | null = null;
    try {
      detected = await driver.detectCurrent();
    } catch {
      detected = null;
    }

    // Do not overwrite vault while a switch/login is mid-flight on the keyring.
    if (detected && !activeMutations.has(adapter)) {
      const active = getActiveAccountRecord(adapter);
      if (active && isSameManagedSlot(active, detected)) {
        updateAccountCredential(active.id, detected.rawSecret, {
          accountIdentity: detected.identity,
          authMethod: detected.authMethod
        });
      }
    }

    return buildState(adapter, driver, detected);
  }

  async function importCurrentSystemAccount(
    adapter: string,
    label?: string
  ): Promise<CliAccountMutationResult> {
    const driver = drivers.get(adapter);
    if (!driver) {
      throw new Error(`Account management is not supported for ${adapter}.`);
    }

    return withAdapterLock(adapter, async () => {
      const detected = await driver.detectCurrent();
      if (!detected) {
        throw new Error("No active system login was found in the OS keyring.");
      }

      const existing = detected.identity
        ? findAccountByIdentity(adapter, detected.identity)
        : undefined;

      let record: CliAgentAccountRecord;
      if (existing) {
        const updated = updateAccountCredential(existing.id, detected.rawSecret, {
          accountIdentity: detected.identity,
          authMethod: detected.authMethod
        });
        record = updated ?? existing;
        if (label?.trim()) {
          record = updateAccountLabel(record.id, label);
        }
        setActiveAccountInDb(adapter, record.id);
      } else {
        record = createAccountRecord({
          adapter,
          label: label?.trim() || detected.identity || "Antigravity",
          accountIdentity: detected.identity,
          authMethod: detected.authMethod,
          storageMode: driver.storageMode,
          rawSecret: detected.rawSecret,
          isActive: true
        });
      }

      bumpAccountRevision(adapter);
      disposeWarmPool(adapter);
      await bestEffortRefreshSingleQuota(driver, record, detected.rawSecret);
      const refreshed = getAccountRecord(record.id) ?? record;
      notifyChanged(adapter);
      const state = buildState(adapter, driver, detected);
      return { account: toPublicAccount(refreshed), state };
    });
  }

  async function switchAccount(
    adapter: string,
    targetAccountId: string
  ): Promise<CliAccountMutationResult> {
    const driver = drivers.get(adapter);
    if (!driver || driver.storageMode !== "global-slot" || !driver.writeSecret) {
      throw new Error(`Account switching is not supported for ${adapter}.`);
    }

    return withAdapterLock(adapter, async () => {
      if (hasActiveRuns(adapter)) {
        throw new Error(
          "Cannot switch account while an active task is running for this agent."
        );
      }

      const target = getAccountRecord(targetAccountId);
      if (!target || target.adapter !== adapter) {
        throw new Error("Target account was not found.");
      }

      const targetSecret = decryptAccountCredential(target);
      if (!targetSecret) {
        throw new Error(
          "Stored credentials for this account are unavailable. Please sign in again."
        );
      }

      const detected = await driver.detectCurrent();
      syncDetectedCredentialToVault(adapter, detected, {
        allowAutoSaveUnmanaged: true
      });

      await driver.writeSecret!(targetSecret);
      setActiveAccountInDb(adapter, target.id);
      bumpAccountRevision(adapter);
      disposeWarmPool(adapter);

      await bestEffortRefreshSingleQuota(driver, target, targetSecret);
      const refreshedTarget = getAccountRecord(target.id) ?? target;
      const postDetected =
        (await driver.detectCurrent().catch(() => null)) ?? {
          rawSecret: targetSecret,
          identity: refreshedTarget.accountIdentity,
          authMethod: refreshedTarget.authMethod
        };

      notifyChanged(adapter);
      const state = buildState(adapter, driver, postDetected);
      return { account: toPublicAccount(refreshedTarget), state };
    });
  }

  async function startInteractiveAccountLogin(
    input: CliAccountLoginInput,
    emit: (event: CliEvent) => void
  ): Promise<CliAccountMutationResult> {
    const driver = drivers.get(input.adapter);
    if (!driver) {
      throw new Error(`Account login is not supported for ${input.adapter}.`);
    }

    return withAdapterLock(input.adapter, async () => {
      if (hasActiveRuns(input.adapter)) {
        throw new Error(
          "Cannot add or re-authenticate an account while an active task is running for this agent."
        );
      }

      let reloginTarget: CliAgentAccountRecord | undefined;
      if (input.reloginAccountId) {
        reloginTarget = getAccountRecord(input.reloginAccountId);
        if (!reloginTarget || reloginTarget.adapter !== input.adapter) {
          throw new Error("Account to re-authenticate was not found.");
        }
      }

      const backup = await driver.detectCurrent();
      if (backup) {
        const matchesRelogin =
          reloginTarget && isSameManagedSlot(reloginTarget, backup);
        syncDetectedCredentialToVault(input.adapter, backup, {
          allowAutoSaveUnmanaged: !matchesRelogin
        });
      }

      await driver.clearSecret?.();

      let postLogin: DetectedCredential | null = null;
      try {
        await driver.runInteractiveLogin({
          binary: input.binary,
          env: input.env,
          emit
        });
        postLogin = await driver.detectCurrent();
        if (!postLogin) {
          throw new Error(
            "Sign-in completed, but no credential was found in the system keyring."
          );
        }
      } catch (error) {
        if (backup && driver.writeSecret) {
          try {
            await driver.writeSecret(backup.rawSecret);
          } catch {
            // Best-effort rollback of previous credential.
          }
        }
        throw error;
      }

      let targetRecord: CliAgentAccountRecord;
      const existingByIdentity = postLogin.identity
        ? findAccountByIdentity(input.adapter, postLogin.identity)
        : undefined;

      if (reloginTarget && (!existingByIdentity || existingByIdentity.id === reloginTarget.id)) {
        targetRecord =
          updateAccountCredential(reloginTarget.id, postLogin.rawSecret, {
            accountIdentity: postLogin.identity,
            authMethod: postLogin.authMethod
          }) ?? reloginTarget;
        if (input.label?.trim()) {
          targetRecord = updateAccountLabel(targetRecord.id, input.label);
        }
      } else if (existingByIdentity) {
        targetRecord =
          updateAccountCredential(existingByIdentity.id, postLogin.rawSecret, {
            accountIdentity: postLogin.identity,
            authMethod: postLogin.authMethod
          }) ?? existingByIdentity;
        if (input.label?.trim()) {
          targetRecord = updateAccountLabel(targetRecord.id, input.label);
        }
      } else {
        targetRecord = createAccountRecord({
          adapter: input.adapter,
          label: input.label?.trim() || postLogin.identity || "Antigravity",
          accountIdentity: postLogin.identity,
          authMethod: postLogin.authMethod,
          storageMode: driver.storageMode,
          rawSecret: postLogin.rawSecret,
          isActive: true
        });
      }

      setActiveAccountInDb(input.adapter, targetRecord.id);
      bumpAccountRevision(input.adapter);
      disposeWarmPool(input.adapter);

      await bestEffortRefreshSingleQuota(driver, targetRecord, postLogin.rawSecret);
      const refreshed = getAccountRecord(targetRecord.id) ?? targetRecord;

      notifyChanged(input.adapter);
      const state = buildState(input.adapter, driver, postLogin);
      return { account: toPublicAccount(refreshed), state };
    });
  }

  async function refreshAccountQuota(
    adapter: string,
    accountId?: string
  ): Promise<CliAgentSystemAccountState> {
    const driver = drivers.get(adapter);
    if (!driver) {
      return buildState(adapter, undefined, null);
    }

    let detected: DetectedCredential | null = null;
    await withAdapterLock(adapter, async () => {
      detected = await driver.detectCurrent().catch(() => null);
      if (detected) {
        const active = getActiveAccountRecord(adapter);
        if (active && isSameManagedSlot(active, detected)) {
          updateAccountCredential(active.id, detected.rawSecret, {
            accountIdentity: detected.identity,
            authMethod: detected.authMethod
          });
        }
      }
    });

    const targets = accountId
      ? [getAccountRecord(accountId)].filter(
          (record): record is CliAgentAccountRecord =>
            Boolean(record && record.adapter === adapter)
        )
      : listAccountRecords(adapter);

    if (driver.readUsageForSecret && targets.length > 0) {
      await Promise.allSettled(
        targets.map(async (record) => {
          const secret = decryptAccountCredential(record);
          if (!secret) {
            updateAccountQuota(record.id, {
              ok: false,
              reason: "missing_auth",
              error: "Stored credentials unavailable",
              fetchedAt: new Date().toISOString()
            });
            return;
          }
          const snapshot = await driver.readUsageForSecret!(secret);
          updateAccountQuota(record.id, snapshot);
        })
      );
    }

    notifyChanged(adapter);
    const freshDetected =
      detected ?? (await driver.detectCurrent().catch(() => null));
    return buildState(adapter, driver, freshDetected);
  }

  async function renameAccount(
    id: string,
    label: string
  ): Promise<CliAccountMutationResult> {
    const updated = updateAccountLabel(id, label);
    const driver = drivers.get(updated.adapter);
    const detected = driver ? await driver.detectCurrent().catch(() => null) : null;
    notifyChanged(updated.adapter);
    return {
      account: toPublicAccount(updated),
      state: buildState(updated.adapter, driver, detected)
    };
  }

  async function deleteAccount(id: string): Promise<CliAgentSystemAccountState> {
    const initial = getAccountRecord(id);
    if (!initial) {
      throw new Error("Account not found.");
    }
    return withAdapterLock(initial.adapter, async () => {
      const existing = getAccountRecord(id);
      if (!existing) {
        throw new Error("Account not found.");
      }
      deleteAccountRecord(id);
      if (existing.isActive) {
        bumpAccountRevision(existing.adapter);
        disposeWarmPool(existing.adapter);
      }
      const driver = drivers.get(existing.adapter);
      const detected = driver ? await driver.detectCurrent().catch(() => null) : null;
      notifyChanged(existing.adapter);
      return buildState(existing.adapter, driver, detected);
    });
  }

  function recordActiveUsageSnapshot(
    adapter: string,
    snapshot: CliAccountQuotaSnapshot
  ): void {
    try {
      const active = getActiveAccountRecord(adapter);
      if (!active) return;
      if (
        snapshot.ok &&
        snapshot.email &&
        active.accountIdentity &&
        !identitiesEqual(snapshot.email, active.accountIdentity)
      ) {
        return;
      }
      updateAccountQuota(active.id, snapshot);
      notifyChanged(adapter);
    } catch {
      // Best-effort sync; usage read response should still succeed.
    }
  }

  return {
    getAccountsState,
    importCurrentSystemAccount,
    switchAccount,
    startInteractiveAccountLogin,
    refreshAccountQuota,
    renameAccount,
    deleteAccount,
    recordActiveUsageSnapshot
  };
}

const defaultManager = createCliAccountManager();

export const getAccountsState = defaultManager.getAccountsState;
export const importCurrentSystemAccount = defaultManager.importCurrentSystemAccount;
export const switchAccount = defaultManager.switchAccount;
export const startInteractiveAccountLogin = defaultManager.startInteractiveAccountLogin;
export const refreshAccountQuota = defaultManager.refreshAccountQuota;
export const renameAccount = defaultManager.renameAccount;
export const deleteAccount = defaultManager.deleteAccount;
export const recordActiveUsageSnapshot = defaultManager.recordActiveUsageSnapshot;
