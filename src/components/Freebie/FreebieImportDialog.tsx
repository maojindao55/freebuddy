import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import {
  baseAdapterForProtocol,
  buildFreebieOverride,
  defaultEnvKeyForProtocol
} from "@/services/freebie/presetToOverride";
import type { FreebieProviderPreset } from "@/services/freebie/protocol";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";

const RUNTIME_LABEL: Record<string, string> = {
  "codex-acp": "Codex",
  "claude-agent-acp": "Claude Code",
  "dsh-acp": "DeepSeek"
};

export interface FreebieImportDialogProps {
  preset: FreebieProviderPreset;
  alreadyImported: boolean;
  /** `false` when the base CLI is known to be missing; `true` when installed or unknown. */
  runtimeInstalled: boolean;
  /** Called once with the created agent id, or `null` when the user cancels before creating. */
  onResult: (agentId: string | null) => void;
  onStartChat: (agentId: string) => void;
  onOpenAgentSettings: () => void;
  onClose: () => void;
}

export function FreebieImportDialog({
  preset,
  alreadyImported,
  runtimeInstalled,
  onResult,
  onStartChat,
  onOpenAgentSettings,
  onClose
}: FreebieImportDialogProps) {
  const { t } = useTranslation();
  const upsertOverride = useCliExecutorStore((s) => s.upsertOverride);
  const refreshMembers = useConversationStore((s) => s.refreshMembers);

  const [apiKey, setApiKey] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() =>
    preset.models.map((model) => model.id)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const resultSentRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const baseAdapter = baseAdapterForProtocol(preset.protocol);
  const envKey = preset.envKey ?? defaultEnvKeyForProtocol(preset.protocol);
  const protocolLabel = useMemo(() => {
    switch (preset.protocol) {
      case "anthropic":
        return t("freebie.protocol.anthropic");
      case "deepseek":
        return t("freebie.protocol.deepseek");
      case "openai-responses":
        return t("freebie.protocol.openaiResponses");
      default:
        return t("freebie.protocol.openaiChat");
    }
  }, [preset.protocol, t]);

  const finish = (agentId: string | null) => {
    if (!resultSentRef.current) {
      resultSentRef.current = true;
      onResult(agentId);
    }
  };

  const cancel = () => {
    if (saving) return;
    finish(createdAgentId);
    onClose();
  };

  useEffect(() => {
    dialogRef.current?.querySelector<HTMLInputElement>("input[type=password]")?.focus();
  }, []);

  const toggleModel = (id: string) => {
    setSelectedModelIds((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  };

  const canSubmit = apiKey.trim().length > 0 && selectedModelIds.length > 0 && !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const ordered = preset.models
        .map((model) => model.id)
        .filter((id) => selectedModelIds.includes(id));
      const override = buildFreebieOverride({
        preset,
        apiKey,
        modelIds: ordered,
        label: t("freebie.agentLabel", { name: preset.name })
      });
      await upsertOverride(override);
      refreshMembers();
      const agentId = `cli-${override.id}`;
      setCreatedAgentId(agentId);
      setApiKey("");
      finish(agentId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-backdrop freebie-import-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        ref={dialogRef}
        className="modal freebie-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="freebie-import-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
      >
        <div className="freebie-import-header">
          <div>
            <h3 id="freebie-import-title">
              {createdAgentId ? t("freebie.import.doneTitle") : t("freebie.import.title")}
            </h3>
            <p>
              {createdAgentId
                ? t("freebie.import.doneDescription", { name: preset.name })
                : t("freebie.import.description", { name: preset.name })}
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            disabled={saving}
            onClick={cancel}
            aria-label={t("common.close")}
          >
            <X size={17} />
          </button>
        </div>

        {createdAgentId ? (
          <>
            <div className="freebie-import-success">
              <CheckCircle2 size={20} aria-hidden="true" />
              <span>{t("freebie.import.successHint")}</span>
            </div>
            <div className="freebie-import-actions">
              <button type="button" className="secondary" onClick={cancel}>
                {t("common.close")}
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  finish(createdAgentId);
                  onClose();
                  onStartChat(createdAgentId);
                }}
              >
                {t("freebie.import.startChat")}
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="freebie-import-facts">
              <div>
                <dt>{t("freebie.import.protocol")}</dt>
                <dd>
                  {protocolLabel}
                  <span className="freebie-import-muted">
                    {" · "}
                    {t("freebie.import.baseAdapter", { runtime: RUNTIME_LABEL[baseAdapter] })}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{t("freebie.import.baseUrl")}</dt>
                <dd>
                  <code>{preset.baseUrl}</code>
                </dd>
              </div>
              <div>
                <dt>{t("freebie.import.envKey")}</dt>
                <dd>
                  <code>{envKey}</code>
                </dd>
              </div>
            </dl>

            <fieldset className="freebie-import-models">
              <legend>{t("freebie.import.models")}</legend>
              {preset.models.map((model) => (
                <label key={model.id} className="freebie-import-model">
                  <input
                    type="checkbox"
                    checked={selectedModelIds.includes(model.id)}
                    onChange={() => toggleModel(model.id)}
                  />
                  <span className="freebie-import-model-name">{model.name ?? model.id}</span>
                  {model.name ? <code>{model.id}</code> : null}
                </label>
              ))}
              {selectedModelIds.length === 0 ? (
                <small className="freebie-import-error-text">
                  {t("freebie.import.selectAtLeastOne")}
                </small>
              ) : null}
            </fieldset>

            <label className="freebie-import-field">
              <span>{t("freebie.import.apiKey")}</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={(event) => setApiKey(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submit();
                }}
                placeholder={t("freebie.import.apiKeyPlaceholder")}
              />
              <small>
                {t("freebie.import.apiKeyHint")}
                {preset.consoleUrl ? (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="freebie-link-button"
                      onClick={() => void cliClient.openBrowserExternal(preset.consoleUrl!)}
                    >
                      {t("freebie.import.getKey")}
                      <ExternalLink size={12} aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </small>
            </label>

            {!runtimeInstalled ? (
              <div className="freebie-import-notice warning">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>
                  {t("freebie.import.runtimeMissing", { runtime: RUNTIME_LABEL[baseAdapter] })}{" "}
                  <button type="button" className="freebie-link-button" onClick={onOpenAgentSettings}>
                    {t("freebie.import.openAgentSettings")}
                  </button>
                </span>
              </div>
            ) : null}

            {alreadyImported ? (
              <div className="freebie-import-notice">
                <span>{t("freebie.import.alreadyImported")}</span>
              </div>
            ) : null}

            <div className="freebie-import-notice security">
              <AlertTriangle size={17} aria-hidden="true" />
              <span>{t("freebie.import.securityNote")}</span>
            </div>

            {error ? (
              <div className="freebie-import-notice error" role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="freebie-import-actions">
              <button type="button" className="secondary" disabled={saving} onClick={cancel}>
                {t("common.cancel")}
              </button>
              <button type="button" className="primary" disabled={!canSubmit} onClick={() => void submit()}>
                {saving ? t("common.saving") : t("freebie.import.create")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
