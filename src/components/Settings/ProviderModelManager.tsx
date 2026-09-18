import React, { useState, useMemo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Search,
  Plus,
  Trash2,
  X,
  Copy,
  Check,
  Settings,
  Brain,
  Wrench,
  Eye,
  Code,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Layers,
  LayoutList,
  Tags,
  FileText,
} from "lucide-react";
import type { ProviderModel } from "@/services/providers/types";
import {
  getModelBrand,
  inferModelCapabilities,
  inferContextWindow,
  inferModelGroup,
  formatTokenCount,
} from "@/services/providers/modelUtils";
import { ModelConfigModal } from "./ModelConfigModal";

interface ProviderModelManagerProps {
  models: ProviderModel[];
  onChange: (models: ProviderModel[]) => void;
}

type CapabilityFilter = "all" | "reasoning" | "tools" | "vision" | "code";
type ViewMode = "list" | "tags" | "batch";

export const ProviderModelManager: React.FC<ProviderModelManagerProps> = ({
  models,
  onChange,
}) => {
  const { t } = useTranslation();

  // Search & Filters
  const [searchText, setSearchText] = useState("");
  const [capFilter, setCapFilter] = useState<CapabilityFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [newModelId, setNewModelId] = useState("");
  const [rawBatchText, setRawBatchText] = useState("");

  // Group expansion state: record of groupName -> boolean (true = expanded)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [allExpanded, setAllExpanded] = useState(true);

  // Copy feedback state: modelId -> boolean
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Active model for Advanced Config modal
  const [configModel, setConfigModel] = useState<ProviderModel | null>(null);

  // Handle copy
  const handleCopy = useCallback((id: string) => {
    navigator.clipboard.writeText(id).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  }, []);

  // Add single model
  const handleAddModel = useCallback(
    (idToAdd: string) => {
      const clean = idToAdd.trim();
      if (!clean) return;
      if (models.some((m) => m.id.toLowerCase() === clean.toLowerCase())) {
        setNewModelId("");
        return;
      }
      const defaultCtx = inferContextWindow(clean);
      const caps = inferModelCapabilities(clean);
      const newEntry: ProviderModel = {
        id: clean,
        contextWindow: defaultCtx,
        supportsTools: caps.tools,
        supportsReasoning: caps.reasoning,
        supportsVision: caps.vision,
        group: inferModelGroup(clean),
      };
      onChange([...models, newEntry]);
      setNewModelId("");
    },
    [models, onChange],
  );

  // Remove model
  const handleRemoveModel = useCallback(
    (idToRemove: string) => {
      onChange(models.filter((m) => m.id !== idToRemove));
    },
    [models, onChange],
  );

  // Update model config
  const handleSaveModelConfig = useCallback(
    (updated: ProviderModel) => {
      onChange(models.map((m) => (m.id === updated.id ? updated : m)));
    },
    [models, onChange],
  );

  // Toggle View Modes
  const handleSwitchToBatch = () => {
    setRawBatchText(models.map((m) => m.id).join("\n"));
    setViewMode("batch");
  };

  const handleApplyBatch = (text: string) => {
    const lines = text
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const unique = Array.from(new Set(lines));

    // Preserve existing models' configs
    const existingMap = new Map(models.map((m) => [m.id, m]));
    const nextModels: ProviderModel[] = unique.map((id) => {
      if (existingMap.has(id)) {
        return existingMap.get(id)!;
      }
      const defaultCtx = inferContextWindow(id);
      const caps = inferModelCapabilities(id);
      return {
        id,
        contextWindow: defaultCtx,
        supportsTools: caps.tools,
        supportsReasoning: caps.reasoning,
        supportsVision: caps.vision,
        group: inferModelGroup(id),
      };
    });

    onChange(nextModels);
    setViewMode("list");
  };

  // Toggle collapse
  const toggleGroup = (groupName: string) => {
    setCollapsedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName],
    }));
  };

  const toggleAllGroups = () => {
    const nextState = !allExpanded;
    setAllExpanded(nextState);
    // If expanding all, clear collapsedGroups. If collapsing all, mark all as true (collapsed)
    if (nextState) {
      setCollapsedGroups({});
    } else {
      const allCollapsed: Record<string, boolean> = {};
      for (const g of Object.keys(groupedModels)) {
        allCollapsed[g] = true;
      }
      setCollapsedGroups(allCollapsed);
    }
  };

  // Filtered models
  const filteredModels = useMemo(() => {
    let list = models;
    const query = searchText.trim().toLowerCase();
    if (query) {
      list = list.filter(
        (m) =>
          m.id.toLowerCase().includes(query) ||
          m.name?.toLowerCase().includes(query) ||
          m.group?.toLowerCase().includes(query),
      );
    }

    if (capFilter !== "all") {
      list = list.filter((m) => {
        const caps = inferModelCapabilities(m.id, {
          supportsReasoning: m.supportsReasoning,
          supportsTools: m.supportsTools,
          supportsVision: m.supportsVision,
        });
        if (capFilter === "reasoning") return caps.reasoning;
        if (capFilter === "tools") return caps.tools;
        if (capFilter === "vision") return caps.vision;
        if (capFilter === "code") return caps.code;
        return true;
      });
    }

    return list;
  }, [models, searchText, capFilter]);

  // Grouped models
  const groupedModels = useMemo(() => {
    const groups: Record<string, ProviderModel[]> = {};
    for (const m of filteredModels) {
      const g = inferModelGroup(m.id, m.group);
      if (!groups[g]) groups[g] = [];
      groups[g].push(m);
    }
    return groups;
  }, [filteredModels]);

  // Capability counts for tabs
  const counts = useMemo(() => {
    const c = { all: models.length, reasoning: 0, tools: 0, vision: 0, code: 0 };
    for (const m of models) {
      const caps = inferModelCapabilities(m.id, {
        supportsReasoning: m.supportsReasoning,
        supportsTools: m.supportsTools,
        supportsVision: m.supportsVision,
      });
      if (caps.reasoning) c.reasoning++;
      if (caps.tools) c.tools++;
      if (caps.vision) c.vision++;
      if (caps.code) c.code++;
    }
    return c;
  }, [models]);

  return (
    <div className="provider-model-manager">
      {/* 1. Header Toolbar */}
      <div className="model-mgr-toolbar">
        <div className="model-mgr-toolbar-left">
          <span className="model-mgr-count-badge">
            {t("providers.modelTotalCount", "模型")} ({models.length})
          </span>
          {filteredModels.length !== models.length && (
            <span className="model-mgr-filtered-badge">
              匹配 {filteredModels.length}
            </span>
          )}
        </div>

        <div className="model-mgr-toolbar-right">
          {models.length > 0 && viewMode !== "batch" && (
            <button
              type="button"
              className="provider-text-btn danger"
              onClick={() => onChange([])}
              title={t("providers.clearModels", "清空全部")}
            >
              <Trash2 size={12} />
              {t("providers.clearModels", "清空全部")}
            </button>
          )}

          {/* View mode buttons */}
          <div className="model-mgr-view-toggle">
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title="结构化列表视图"
            >
              <LayoutList size={13} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "tags" ? "active" : ""}`}
              onClick={() => setViewMode("tags")}
              title="紧凑胶囊视图"
            >
              <Tags size={13} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "batch" ? "active" : ""}`}
              onClick={handleSwitchToBatch}
              title="批量换行编辑"
            >
              <FileText size={13} />
            </button>
          </div>
        </div>
      </div>

      {viewMode === "batch" ? (
        /* Batch Edit Mode */
        <div className="model-mgr-batch-panel">
          <p className="model-mgr-batch-hint">
            {t(
              "providers.batchEditHint",
              "每行输入一个模型 ID。保存时将保留已存在配置的模型参数，自动解析新增模型。",
            )}
          </p>
          <textarea
            value={rawBatchText}
            onChange={(e) => setRawBatchText(e.target.value)}
            rows={8}
            className="provider-models-textarea"
            placeholder="gpt-4o&#10;claude-3-7-sonnet&#10;deepseek-chat&#10;deepseek-reasoner"
          />
          <div className="model-mgr-batch-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setViewMode("list")}
            >
              {t("common.cancel", "取消")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => handleApplyBatch(rawBatchText)}
            >
              <Check size={13} />
              {t("providers.applyBatch", "应用并更新列表")}
            </button>
          </div>
        </div>
      ) : (
        /* List or Tags Mode */
        <>
          {/* Quick Add row */}
          <div className="provider-model-input-row">
            <input
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddModel(newModelId);
                }
              }}
              placeholder={t("providers.addModelPlaceholder", "输入模型 ID（如 gpt-4o），按回车添加")}
            />
            <button
              type="button"
              className="provider-secondary-btn"
              disabled={!newModelId.trim()}
              onClick={() => handleAddModel(newModelId)}
            >
              <Plus size={14} />
              {t("providers.addModel", "添加")}
            </button>
          </div>

          {/* Search & Capability Filter Row */}
          {models.length > 0 && (
            <div className="model-mgr-search-filter-row">
              <div className="model-mgr-search-wrap">
                <Search size={13} className="model-mgr-search-icon" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t("providers.searchModels", "搜索模型 ID、别名...")}
                  className="model-mgr-search-input"
                />
                {searchText && (
                  <button
                    type="button"
                    className="model-mgr-search-clear"
                    onClick={() => setSearchText("")}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              {/* Capability Tabs */}
              <div className="model-mgr-cap-tabs">
                <button
                  type="button"
                  className={`cap-tab ${capFilter === "all" ? "active" : ""}`}
                  onClick={() => setCapFilter("all")}
                >
                  全部 ({counts.all})
                </button>
                <button
                  type="button"
                  className={`cap-tab ${capFilter === "reasoning" ? "active" : ""}`}
                  onClick={() => setCapFilter("reasoning")}
                >
                  🧠 推理 ({counts.reasoning})
                </button>
                <button
                  type="button"
                  className={`cap-tab ${capFilter === "tools" ? "active" : ""}`}
                  onClick={() => setCapFilter("tools")}
                >
                  🛠️ 工具 ({counts.tools})
                </button>
                <button
                  type="button"
                  className={`cap-tab ${capFilter === "vision" ? "active" : ""}`}
                  onClick={() => setCapFilter("vision")}
                >
                  👁️ 视觉 ({counts.vision})
                </button>
                <button
                  type="button"
                  className={`cap-tab ${capFilter === "code" ? "active" : ""}`}
                  onClick={() => setCapFilter("code")}
                >
                  💻 代码 ({counts.code})
                </button>
              </div>

              {/* Expand/Collapse All (for list view) */}
              {viewMode === "list" && (
                <button
                  type="button"
                  className="model-mgr-group-toggle-all"
                  onClick={toggleAllGroups}
                  title={allExpanded ? "全部收起" : "全部展开"}
                >
                  {allExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                </button>
              )}
            </div>
          )}

          {/* Model Content Area */}
          {filteredModels.length === 0 ? (
            <div className="provider-models-empty-hint">
              {searchText || capFilter !== "all"
                ? t("providers.noFilterResults", "未找到符合过滤条件的模型")
                : t("providers.noModelsFound", "暂无配置的模型，点击上方“拉取模型列表”或手动添加")}
            </div>
          ) : viewMode === "tags" ? (
            /* Tags View */
            <div className="model-mgr-tags-container">
              {filteredModels.map((m) => {
                const brand = getModelBrand(m.id);
                const caps = inferModelCapabilities(m.id, {
                  supportsReasoning: m.supportsReasoning,
                  supportsTools: m.supportsTools,
                  supportsVision: m.supportsVision,
                });
                return (
                  <div key={m.id} className="model-mgr-tag-card">
                    <span
                      className="model-tag-brand-dot"
                      style={{ backgroundColor: brand.color }}
                    />
                    <code className="model-tag-name">{m.name || m.id}</code>
                    <div className="model-tag-badges">
                      {caps.reasoning && <span className="mini-badge purple">🧠</span>}
                      {caps.tools && <span className="mini-badge green">🛠️</span>}
                      {caps.vision && <span className="mini-badge blue">👁️</span>}
                    </div>
                    <button
                      type="button"
                      className="model-mgr-icon-btn edit"
                      onClick={() => setConfigModel(m)}
                      title="配置高级参数"
                    >
                      <Settings size={11} />
                    </button>
                    <button
                      type="button"
                      className="model-mgr-icon-btn del"
                      onClick={() => handleRemoveModel(m.id)}
                      title="删除模型"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          ) : (
            /* Grouped Structured List View */
            <div className="model-mgr-groups-container">
              {Object.entries(groupedModels).map(([groupName, groupList]) => {
                const isCollapsed = Boolean(collapsedGroups[groupName]);
                return (
                  <div key={groupName} className="model-mgr-group">
                    {/* Group Header */}
                    <div
                      className="model-mgr-group-header"
                      onClick={() => toggleGroup(groupName)}
                    >
                      <div className="model-mgr-group-title">
                        {isCollapsed ? (
                          <ChevronRight size={14} className="group-arrow" />
                        ) : (
                          <ChevronDown size={14} className="group-arrow" />
                        )}
                        <span className="group-name">{groupName}</span>
                        <span className="group-count">({groupList.length})</span>
                      </div>
                    </div>

                    {/* Group Items */}
                    {!isCollapsed && (
                      <div className="model-mgr-group-body">
                        {groupList.map((m) => {
                          const brand = getModelBrand(m.id);
                          const caps = inferModelCapabilities(m.id, {
                            supportsReasoning: m.supportsReasoning,
                            supportsTools: m.supportsTools,
                            supportsVision: m.supportsVision,
                          });
                          const ctxText = formatTokenCount(m.contextWindow);
                          const maxText = formatTokenCount(m.maxTokens);
                          const isCopied = copiedId === m.id;

                          return (
                            <div key={m.id} className="model-mgr-row-card">
                              {/* Left: Brand Avatar + Name / ID */}
                              <div className="model-row-left">
                                <div
                                  className="model-row-avatar"
                                  style={{
                                    color: brand.color,
                                    backgroundColor: brand.bg,
                                    borderColor: brand.border,
                                  }}
                                  title={brand.name}
                                >
                                  {brand.badge}
                                </div>
                                <div className="model-row-info">
                                  {m.name ? (
                                    <>
                                      <div className="model-row-alias">{m.name}</div>
                                      <code className="model-row-id sub">{m.id}</code>
                                    </>
                                  ) : (
                                    <code className="model-row-id primary">{m.id}</code>
                                  )}
                                </div>
                              </div>

                              {/* Middle: Capability & Spec Badges */}
                              <div className="model-row-center">
                                <div className="model-cap-pill-cluster">
                                  {caps.reasoning && (
                                    <span className="cap-pill reasoning">
                                      <Brain size={11} />
                                      <span>推理</span>
                                    </span>
                                  )}
                                  {caps.tools && (
                                    <span className="cap-pill tools">
                                      <Wrench size={11} />
                                      <span>工具</span>
                                    </span>
                                  )}
                                  {caps.vision && (
                                    <span className="cap-pill vision">
                                      <Eye size={11} />
                                      <span>视觉</span>
                                    </span>
                                  )}
                                  {caps.code && (
                                    <span className="cap-pill code">
                                      <Code size={11} />
                                      <span>代码</span>
                                    </span>
                                  )}
                                  {ctxText && (
                                    <span className="spec-pill" title="上下文长度">
                                      {ctxText} ctx
                                    </span>
                                  )}
                                  {maxText && (
                                    <span className="spec-pill out" title="最大输出 Tokens">
                                      {maxText} out
                                    </span>
                                  )}
                                </div>
                              </div>

                              {/* Right: Actions */}
                              <div className="model-row-actions">
                                <button
                                  type="button"
                                  className="model-action-btn"
                                  onClick={() => handleCopy(m.id)}
                                  title="复制模型 ID"
                                >
                                  {isCopied ? (
                                    <Check size={13} className="text-emerald-500" />
                                  ) : (
                                    <Copy size={13} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="model-action-btn"
                                  onClick={() => setConfigModel(m)}
                                  title="配置高级参数"
                                >
                                  <Settings size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="model-action-btn danger"
                                  onClick={() => handleRemoveModel(m.id)}
                                  title="移除模型"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Model Config Modal */}
      <ModelConfigModal
        open={Boolean(configModel)}
        model={configModel}
        onClose={() => setConfigModel(null)}
        onSave={handleSaveModelConfig}
      />
    </div>
  );
};
