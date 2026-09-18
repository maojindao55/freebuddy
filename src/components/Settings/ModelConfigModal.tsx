import React, { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  SlidersHorizontal,
  Brain,
  Wrench,
  Eye,
  Check,
  Sparkles,
} from "lucide-react";
import type { ProviderModel } from "@/services/providers/types";
import {
  getModelBrand,
  inferModelCapabilities,
  inferContextWindow,
} from "@/services/providers/modelUtils";

interface ModelConfigModalProps {
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

export const ModelConfigModal: React.FC<ModelConfigModalProps> = ({
  open,
  model,
  onClose,
  onSave,
}) => {
  const { t } = useTranslation();

  if (!open || !model) return null;

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
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-container model-config-modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 520 }}
      >
        <div className="modal-header">
          <div className="model-config-header-title">
            <SlidersHorizontal size={18} className="model-config-title-icon" />
            <span>{t("providers.modelConfigTitle", "配置模型高级参数")}</span>
          </div>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSave}>
          <div className="modal-body model-config-body">
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
                <span className="model-config-target-brand">{brand.name} 系列</span>
              </div>
            </div>

            {/* Display Name */}
            <label className="provider-form-label">
              <span>{t("providers.modelDisplayName", "显示别名（可选）")}</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="例如：Claude 3.7 思考版 / DeepSeek V3 官网"
              />
            </label>

            {/* Model Group */}
            <label className="provider-form-label">
              <span>{t("providers.modelGroup", "自定义分组（可选）")}</span>
              <input
                value={group}
                onChange={(e) => setGroup(e.target.value)}
                placeholder="例如：主力推荐 / 备用高配 / 编程代码"
              />
            </label>

            {/* Context Window */}
            <div className="provider-form-label">
              <span>{t("providers.contextWindow", "上下文长度 (Context Window)")}</span>
              <input
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value)}
                placeholder="例如：131072 (128K)"
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
              <span>{t("providers.maxTokens", "最大输出限制 (Max Output Tokens)")}</span>
              <input
                type="number"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder="例如：8192 (8K)"
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
                {t("providers.modelCapabilities", "模型能力特性")}
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
                      <strong>{t("providers.capTools", "工具调用 / FC")}</strong>
                    </div>
                    <span className="model-cap-desc">
                      {t("providers.capToolsDesc", "支持 Function Calling，CLI Agent 可调用工具执行命令")}
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
                      <strong>{t("providers.capReasoning", "深度推理 / 思考")}</strong>
                    </div>
                    <span className="model-cap-desc">
                      {t("providers.capReasoningDesc", "如 o1/o3/R1 类推理模型，具备思考阶段与推演过程")}
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
                      <strong>{t("providers.capVision", "多模态视觉")}</strong>
                    </div>
                    <span className="model-cap-desc">
                      {t("providers.capVisionDesc", "支持图像理解与图文混合提示输入")}
                    </span>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="modal-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
            >
              {t("common.cancel", "取消")}
            </button>
            <button type="submit" className="btn btn-primary">
              <Check size={14} />
              {t("common.save", "保存配置")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
