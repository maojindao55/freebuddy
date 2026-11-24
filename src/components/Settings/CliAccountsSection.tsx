import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  Download,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X
} from "lucide-react";

import { useCliAccountsStore } from "@/store/cliAccountsStore";
import type { CliAgentAccount } from "@/services/cli/types";
import {
  extractCompactAccountQuotaPills,
  formatAccountQuotaPercent,
  formatAuthMethodLabel
} from "@/utils/cliAccountQuota";

export function CliAccountsSection({
  adapter,
  binary,
  env
}: {
  adapter: string;
  binary?: string;
  env?: Record<string, string>;
}) {
  const { t } = useTranslation();
  const state = useCliAccountsStore((s) => s.byAdapter[adapter]);
  const loading = useCliAccountsStore((s) => s.loadingByAdapter[adapter] === true);
  const busy = useCliAccountsStore((s) => s.busyByAdapter[adapter] === true);
  const error = useCliAccountsStore((s) => s.errorByAdapter[adapter]);
  const load = useCliAccountsStore((s) => s.load);
  const importCurrent = useCliAccountsStore((s) => s.importCurrent);
  const switchAccount = useCliAccountsStore((s) => s.switchAccount);
  const startLogin = useCliAccountsStore((s) => s.startLogin);
  const refreshQuota = useCliAccountsStore((s) => s.refreshQuota);
  const renameAccount = useCliAccountsStore((s) => s.renameAccount);
  const deleteAccount = useCliAccountsStore((s) => s.deleteAccount);
  const clearError = useCliAccountsStore((s) => s.clearError);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");

  useEffect(() => {
    void load(adapter);
  }, [adapter, load]);

  if (state && !state.supported) {
    return null;
  }

  const accounts = state?.accounts ?? [];
  const hasRunningTasks = state?.hasRunningTasks === true;
  const externalMismatch = state?.externalAccountMismatch === true;
  const detectedIdentity = state?.detectedSystemAccount?.identity;

  const startRename = (account: CliAgentAccount) => {
    setEditingId(account.id);
    setDraftLabel(account.label);
  };

  const cancelRename = () => {
    setEditingId(null);
    setDraftLabel("");
  };

  const commitRename = async (accountId: string) => {
    const trimmed = draftLabel.trim();
    if (!trimmed) return;
    const result = await renameAccount(adapter, accountId, trimmed);
    if (result) {
      setEditingId(null);
      setDraftLabel("");
    }
  };

  const handleDelete = async (account: CliAgentAccount) => {
    if (
      !window.confirm(
        t("settings.cli.accounts.deleteConfirm", { label: account.label })
      )
    ) {
      return;
    }
    await deleteAccount(adapter, account.id);
  };

  return (
    <div className="adapter-editor-section cli-accounts-section">
      <div className="cli-accounts-header">
        <div className="cli-accounts-heading">
          <h4 className="adapter-editor-section-title">
            {t("settings.cli.accounts.title")}
          </h4>
          <p className="settings-field-hint cli-accounts-global-hint">
            {t("settings.cli.accounts.globalSlotHint")}
          </p>
        </div>
        <div className="cli-accounts-toolbar">
          <button
            type="button"
            className="adapter-secondary-action cli-accounts-btn"
            disabled={busy || loading || accounts.length === 0}
            onClick={() => void refreshQuota(adapter)}
          >
            <RefreshCw
              size={13}
              className={busy ? "spin" : undefined}
              aria-hidden="true"
            />
            <span>{t("settings.cli.accounts.refreshAll")}</span>
          </button>
          <button
            type="button"
            className="adapter-editor-action primary cli-accounts-btn"
            disabled={busy || hasRunningTasks}
            title={
              hasRunningTasks
                ? t("settings.cli.accounts.runningTasksBlocked")
                : undefined
            }
            onClick={() =>
              void startLogin({
                adapter,
                binary,
                env
              })
            }
          >
            <Plus size={13} aria-hidden="true" />
            <span>{t("settings.cli.accounts.add")}</span>
          </button>
        </div>
      </div>

      {error ? (
        <div className="cli-account-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="icon-btn cli-account-error-dismiss"
            aria-label={t("common.close", { defaultValue: "Close" })}
            onClick={() => clearError(adapter)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {hasRunningTasks ? (
        <div className="cli-account-banner warn">
          <span>{t("settings.cli.accounts.runningTasksBlocked")}</span>
        </div>
      ) : null}

      {externalMismatch && state?.detectedSystemAccount ? (
        <div className="cli-account-banner">
          <div className="cli-account-banner-copy">
            <strong>{t("settings.cli.accounts.detectedTitle")}</strong>
            <span>
              {t("settings.cli.accounts.detectedDescription", {
                identity:
                  detectedIdentity || t("settings.cli.accounts.unknownIdentity")
              })}
            </span>
          </div>
          <button
            type="button"
            className="adapter-secondary-action cli-accounts-btn"
            disabled={busy}
            onClick={() =>
              void importCurrent(adapter, detectedIdentity || undefined)
            }
          >
            <Download size={13} aria-hidden="true" />
            <span>{t("settings.cli.accounts.importCurrent")}</span>
          </button>
        </div>
      ) : null}

      {loading && accounts.length === 0 ? (
        <p className="muted cli-accounts-empty">{t("settings.cli.loading")}</p>
      ) : accounts.length === 0 ? (
        <p className="muted cli-accounts-empty">
          {t("settings.cli.accounts.empty")}
        </p>
      ) : (
        <div className="cli-account-list">
          {accounts.map((account) => {
            const isRenaming = editingId === account.id;
            const isEffectivelyActive = account.isActive && !externalMismatch;
            const authLabel = formatAuthMethodLabel(account.authMethod, t);
            const pills = extractCompactAccountQuotaPills(
              account.quotaSnapshot,
              3
            );
            const isExpired =
              account.quotaSnapshot?.ok === false &&
              account.quotaSnapshot.reason === "expired_token";
            const hasQuotaError =
              account.quotaSnapshot?.ok === false && !isExpired;
            const showSwitchAction = !account.isActive || externalMismatch;

            return (
              <div
                key={account.id}
                className={`cli-account-card${
                  isEffectivelyActive ? " active" : ""
                }`}
              >
                <div className="cli-account-card-main">
                  <div className="cli-account-card-title-row">
                    {isRenaming ? (
                      <div className="cli-account-rename-row">
                        <input
                          type="text"
                          value={draftLabel}
                          maxLength={80}
                          autoFocus
                          aria-label={t("settings.cli.accounts.renameAria")}
                          onChange={(event) => setDraftLabel(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitRename(account.id);
                            } else if (event.key === "Escape") {
                              event.preventDefault();
                              cancelRename();
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="adapter-secondary-action cli-accounts-icon-btn"
                          disabled={busy || !draftLabel.trim()}
                          aria-label={t("common.save")}
                          title={t("common.save")}
                          onClick={() => void commitRename(account.id)}
                        >
                          <Check size={13} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="adapter-secondary-action cli-accounts-icon-btn"
                          disabled={busy}
                          aria-label={t("common.cancel")}
                          title={t("common.cancel")}
                          onClick={cancelRename}
                        >
                          <X size={13} aria-hidden="true" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <strong className="cli-account-label">
                          {account.label}
                        </strong>
                        {isEffectivelyActive ? (
                          <span className="cli-account-badge active">
                            {t("settings.cli.accounts.activeBadge")}
                          </span>
                        ) : account.isActive && externalMismatch ? (
                          <span className="cli-account-badge out-of-sync">
                            {t("settings.cli.accounts.outOfSyncBadge")}
                          </span>
                        ) : null}
                        {authLabel ? (
                          <span className="cli-account-badge">
                            {authLabel}
                          </span>
                        ) : null}
                      </>
                    )}
                  </div>

                  {account.accountIdentity ? (
                    <div className="cli-account-identity">
                      {account.accountIdentity}
                    </div>
                  ) : null}

                  {pills.length > 0 || isExpired || hasQuotaError ? (
                    <div className="cli-account-quota-row">
                      {pills.length > 0 ? (
                        <div className="cli-account-quota-pills">
                          {pills.map((pill) => (
                            <span
                              key={pill.key}
                              className={`cli-account-quota-pill ${pill.status}${
                                pill.stale ? " stale" : ""
                              }`}
                            >
                              {pill.label}{" "}
                              {formatAccountQuotaPercent(pill.leftPercent)}%
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {isExpired ? (
                        <span className="cli-account-quota-note warn">
                          {t("settings.cli.accounts.expiredHint")}
                        </span>
                      ) : hasQuotaError ? (
                        <span className="cli-account-quota-note">
                          {account.quotaSnapshot?.ok === false &&
                          account.quotaSnapshot.error
                            ? account.quotaSnapshot.error
                            : t("settings.cli.accounts.quotaError")}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </div>

                <div className="cli-account-card-actions">
                  {showSwitchAction ? (
                    <button
                      type="button"
                      className="adapter-secondary-action cli-accounts-switch-btn"
                      disabled={busy || hasRunningTasks}
                      title={
                        hasRunningTasks
                          ? t("settings.cli.accounts.runningTasksBlocked")
                          : undefined
                      }
                      onClick={() => void switchAccount(adapter, account.id)}
                    >
                      {account.isActive && externalMismatch
                        ? t("settings.cli.accounts.restoreActive")
                        : t("settings.cli.accounts.switch")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="adapter-secondary-action cli-accounts-icon-btn"
                    disabled={busy}
                    aria-label={t("settings.cli.accounts.refreshOne")}
                    title={t("settings.cli.accounts.refreshOne")}
                    onClick={() => void refreshQuota(adapter, account.id)}
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="adapter-secondary-action cli-accounts-icon-btn"
                    disabled={busy || hasRunningTasks}
                    aria-label={t("settings.cli.accounts.relogin")}
                    title={t("settings.cli.accounts.relogin")}
                    onClick={() =>
                      void startLogin({
                        adapter,
                        reloginAccountId: account.id,
                        binary,
                        env
                      })
                    }
                  >
                    <KeyRound size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="adapter-secondary-action cli-accounts-icon-btn"
                    disabled={busy}
                    aria-label={t("settings.cli.accounts.rename")}
                    title={t("settings.cli.accounts.rename")}
                    onClick={() => startRename(account)}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="adapter-secondary-action danger cli-accounts-icon-btn"
                    disabled={busy}
                    aria-label={t("common.delete")}
                    title={t("common.delete")}
                    onClick={() => void handleDelete(account)}
                  >
                    <Trash2 size={13} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
