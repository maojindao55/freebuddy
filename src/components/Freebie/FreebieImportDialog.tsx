import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AvatarPicker } from "@/components/Settings/AvatarPicker";
import { cliClient } from "@/services/cli/client";
import {
  buildFreebieOverride,
  defaultEnvKeyForAdapter,
  normalizeFreebieIcon,
  resolveAvailableAgents,
  type FreebieBaseAdapter
} from "@/services/freebie/presetToOverride";
import type { FreebieProviderPreset } from "@/services/freebie/protocol";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useConversationStore } from "@/store/conversationStore";
import { resolveLobehubAvatarUrl } from "@/utils/lobehubAvatar";

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
  const runtimes = useCliExecutorStore((s) => s.runtimes);

  const availableAgents = useMemo(
    () => resolveAvailableAgents(preset.protocols, preset.protocol),
    [preset.protocols, preset.protocol]
  );
  const [selectedAdapter, setSelectedAdapter] = useState<FreebieBaseAdapter>(() => {
    const rec = availableAgents.find((a) => a.isRecommended);
    return rec ? rec.adapter : availableAgents[0].adapter;
  });
  const [avatar, setAvatar] = useState<string>(() => normalizeFreebieIcon(preset.icon) || "");
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);

  const [apiKey, setApiKey] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>(() =>
    preset.models.map((model) => model.id)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdAgentId, setCreatedAgentId] = useState<string | null>(null);
  const resultSentRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  const avatarUrl = useMemo(() => resolveLobehubAvatarUrl(avatar), [avatar]);
  const isRuntimeInstalled =
    runtimes[selectedAdapter] !== undefined
      ? runtimes[selectedAdapter]?.installed !== false
      : runtimeInstalled;

  const envKey = preset.envKey ?? defaultEnvKeyForAdapter(selectedAdapter, preset.protocol);
  const protocolLabel = useMemo(() => {
    const protos = preset.protocols?.length ? preset.protocols : [preset.protocol];
    return protos
      .map((proto) => {
        switch (proto) {
          case "anthropic":
            return t("freebie.protocol.anthropic");
          case "deepseek":
            return t("freebie.protocol.deepseek");
          case "openai-responses":
            return t("freebie.protocol.openaiResponses");
          default:
            return t("freebie.protocol.openaiChat");
        }
      })
      .join(" / ");
  }, [preset.protocols, preset.protocol, t]);

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
        label: t("freebie.agentLabel", { name: preset.name }),
        baseAdapter: selectedAdapter,
        icon: avatar || undefined
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
          <div className="freebie-import-header-lead">
            <button
              type="button"
              className="freebie-import-avatar-btn"
              title={t("freebie.import.changeAvatar")}
              onClick={() => setShowAvatarPicker((prev) => !prev)}
            >
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="freebie-import-avatar-img" />
              ) : (
                <span className="freebie-import-avatar-fallback">
                  {preset.name.slice(0, 2).toUpperCase()}
                </span>
              )}
              <span className="freebie-import-avatar-badge-edit">
                <Pencil size={10} aria-hidden="true" />
              </span>
            </button>
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

        {showAvatarPicker && !createdAgentId ? (
          <div className="freebie-import-picker-card">
            <AvatarPicker
              value={avatar}
              onChange={(val) => {
                setAvatar(val);
                setShowAvatarPicker(false);
              }}
              defaultAdapter={selectedAdapter}
              defaultLabel={preset.name}
            />
          </div>
        ) : null}

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
            {availableAgents.length > 1 ? (
              <div className="freebie-import-field">
                <span>{t("freebie.import.baseAgent")}</span>
                <div className="freebie-import-agent-chips">
                  {availableAgents.map((opt) => {
                    const active = selectedAdapter === opt.adapter;
                    return (
                      <button
                        key={opt.adapter}
                        type="button"
                        className={`freebie-import-agent-chip ${active ? "active" : ""}`}
                        onClick={() => setSelectedAdapter(opt.adapter)}
                      >
                        <span>{opt.label}</span>
                        {opt.isRecommended ? (
                          <span className="freebie-import-chip-rec">
                            {t("freebie.import.recommended")}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <dl className="freebie-import-facts">
              <div>
                <dt>{t("freebie.import.protocol")}</dt>
                <dd>
                  {protocolLabel}
                  <span className="freebie-import-muted">
                    {" · "}
                    {t("freebie.import.baseAdapter", { runtime: RUNTIME_LABEL[selectedAdapter] })}
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

            {!isRuntimeInstalled ? (
              <div className="freebie-import-notice warning">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>
                  {t("freebie.import.runtimeMissing", { runtime: RUNTIME_LABEL[selectedAdapter] })}{" "}
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
