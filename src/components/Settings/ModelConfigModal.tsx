import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  SlidersHorizontal,
  Brain,
  Wrench,
  Eye,
  Check,
} from "lucide-react";
import type { ProviderModel } from "@/services/providers/types";
import {
  getModelBrand,
  inferModelCapabilities,
  inferContextWindow,
} from "@/services/providers/modelUtils";

export interface ModelConfigModalProps {
  open: boolean;
  model: ProviderModel | null;
  onClose: () => void;
  onSave: (model: ProviderModel) => void;
}

const CONTEXT_PRESETS = [
  { label: "16K", val: 16384 },
  { label: "32K", val: 32768 },
  { label: "64K", val: 65536 },
  { label: "128K", val: 131072 },
  { label: "200K", val: 200000 },
  { label: "1M", val: 1000000 },
];

const MAX_TOKENS_PRESETS = [
  { label: "4K", val: 4096 },
  { label: "8K", val: 8192 },
  { label: "16K", val: 16384 },
  { label: "32K", val: 32768 },
  { label: "64K", val: 65536 },
];

interface ModelConfigDrawerContentProps {
  model: ProviderModel;
  onClose: () => void;
  onSave: (model: ProviderModel) => void;
}

const ModelConfigDrawerContent: React.FC<ModelConfigDrawerContentProps> = ({
  model,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();

  const brand = getModelBrand(model.id);
  const inferredCaps = inferModelCapabilities(model.id);
  const defaultCtx = inferContextWindow(model.id);

  const [displayName, setDisplayName] = useState(model.name ?? "");
  const [group, setGroup] = useState(model.group ?? "");
  const [contextWindow, setContextWindow] = useState<string>(
    model.contextWindow ? String(model.contextWindow) : defaultCtx ? String(defaultCtx) : "",
  );
  const [maxTokens, setMaxTokens] = useState<string>(
    model.maxTokens ? String(model.maxTokens) : "",
  );

  const [supportsTools, setSupportsTools] = useState<boolean>(
    model.supportsTools ?? inferredCaps.tools,
  );
  const [supportsReasoning, setSupportsReasoning] = useState<boolean>(
    model.supportsReasoning ?? inferredCaps.reasoning,
  );
  const [supportsVision, setSupportsVision] = useState<boolean>(
    model.supportsVision ?? inferredCaps.vision,
  );

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    const ctxNum = parseInt(contextWindow.trim(), 10);
    const maxNum = parseInt(maxTokens.trim(), 10);

    const updated: ProviderModel = {
      ...model,
      name: displayName.trim() || undefined,
      group: group.trim() || undefined,
      contextWindow: !isNaN(ctxNum) && ctxNum > 0 ? ctxNum : undefined,
      maxTokens: !isNaN(maxNum) && maxNum > 0 ? maxNum : undefined,
      supportsTools,
      supportsReasoning,
      supportsVision,
    };

    onSave(updated);
    onClose();
  };

  return (
    <div className="model-config-drawer-root">
      <div className="model-config-drawer-backdrop" onClick={onClose} />
      <aside
        className="model-config-drawer"
        onClick={(e) => e.stopPropagation()}
        aria-label={t("providers.modelConfigTitle")}
      >
        <div className="model-config-drawer-header">
          <div className="model-config-header-title">
            <SlidersHorizontal size={17} className="model-config-title-icon" />
            <span>{t("providers.modelConfigTitle")}</span>
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSave} className="model-config-drawer-form">
          <div className="model-config-drawer-body">
            {/* Target Model Card */}
            <div className="model-config-target-banner">
              <div
                className="model-brand-avatar"
                style={{
                  color: brand.color,
                  backgroundColor: brand.bg,
                  borderColor: brand.border,
                }}
              >
                {brand.badge}
              </div>
              <div className="model-config-target-info">
                <span className="model-config-target-id">{model.id}</span>
                <span className="model-config-target-brand">
                  {brand.name} {t("providers.series")}
                </span>
              </div>
            </div>

            {/* Display Name */}
            <label className="provider-form-label">
              <span>{t("providers.modelDisplayName")}</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder={t("providers.displayNamePlaceholder")}
              />
            </label>

            {/* Model Group */}
            <label className="provider-form-label">
              <span>{t("providers.modelGroup")}</span>
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder={t("providers.groupPlaceholder")}
              />
            </label>

            {/* Context Window */}
            <div className="provider-form-label">
              <span>{t("providers.contextWindow")}</span>
              <input
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder={t("providers.contextPlaceholder")}
              />
              <div className="model-quick-presets">
                {CONTEXT_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`model-quick-preset-btn ${
                      contextWindow === String(p.val) ? "active" : ""
                    }`}
                    onClick={() => setContextWindow(String(p.val))}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Max Output Tokens */}
            <div className="provider-form-label">
              <span>{t("providers.maxTokens")}</span>
              <input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder={t("providers.maxTokensPlaceholder")}
              />
              <div className="model-quick-presets">
                {MAX_TOKENS_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={`model-quick-preset-btn ${
                      maxTokens === String(p.val) ? "active" : ""
                    }`}
                    onClick={() => setMaxTokens(String(p.val))}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Capability switches */}
            <div className="model-capabilities-group">
              <span className="provider-form-group-title">
                {t("providers.modelCapabilities")}
              </span>
              <div className="model-capabilities-grid">
                {/* Tools */}
                <label className="model-capability-toggle">
                  <input
                    type="checkbox"
                    checked={supportsTools}
                    onChange={(e) => setSupportsTools(e.target.checked)}
                  />
                  <div className="model-cap-toggle-info">
                    <div className="model-cap-label-row">
                      <Wrench size={14} className="text-emerald-500" />
                      <strong>{t("providers.capTools")}</strong>
                    </div>
                    <span className="model-cap-desc">
                      {t("providers.capToolsDesc")}
                    </span>
                  </div>
                </label>

                {/* Reasoning */}
                <label className="model-capability-toggle">
                  <input
                    type="checkbox"
                    checked={supportsReasoning}
                    onChange={(e) => setSupportsReasoning(e.target.checked)}
                  />
                  <div className="model-cap-toggle-info">
                    <div className="model-cap-label-row">
                      <Brain size={14} className="text-purple-500" />
                      <strong>{t("providers.capReasoning")}</strong>
                    </div>
                    <span className="model-cap-desc">
                      {t("providers.capReasoningDesc")}
                    </span>
                  </div>
                </label>

                {/* Vision */}
                <label className="model-capability-toggle">
                  <input
                    type="checkbox"
                    checked={supportsVision}
                    onChange={(e) => setSupportsVision(e.target.checked)}
                  />
                  <div className="model-cap-toggle-info">
                    <div className="model-cap-label-row">
                      <Eye size={14} className="text-blue-500" />
                      <strong>{t("providers.capVision")}</strong>
                    </div>
                    <span className="model-cap-desc">
                      {t("providers.capVisionDesc")}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="model-config-drawer-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              {t("common.cancel")}
            </button>
            <button type="submit" className="btn btn-primary">
              <Check size={14} />
              {t("common.save")}
            </button>
          </div>
        </form>
      </aside>
    </div>
  );
};

export const ModelConfigModal: React.FC<ModelConfigModalProps> = ({
  open,
  model,
  onClose,
  onSave,
}) => {
  if (!open || !model) return null;

  return (
    <ModelConfigDrawerContent
      key={model.id}
      model={model}
      onClose={onClose}
      onSave={onSave}
    />
  );
};

export const ModelConfigDrawer = ModelConfigModal;
