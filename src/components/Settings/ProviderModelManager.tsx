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
    const sortedKeys = Object.keys(groups).sort((a, b) => {
      if (a === "Other") return 1;
      if (b === "Other") return -1;
      return a.localeCompare(b);
    });
    const result: Record<string, ProviderModel[]> = {};
    for (const k of sortedKeys) {
      result[k] = groups[k];
    }
    return result;
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
            {t("providers.modelTotalCount")} ({models.length})
          </span>
          {filteredModels.length !== models.length && (
            <span className="model-mgr-filtered-badge">
              {t("providers.matchedCount", { count: filteredModels.length })}
            </span>
          )}
        </div>

        <div className="model-mgr-toolbar-right">
          {models.length > 0 && viewMode !== "batch" && (
            <button
              type="button"
              className="provider-text-btn danger"
              onClick={() => onChange([])}
              title={t("providers.clearModels")}
            >
              <Trash2 size={12} />
              {t("providers.clearModels")}
            </button>
          )}

          {/* View mode buttons */}
          <div className="model-mgr-view-toggle">
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "list" ? "active" : ""}`}
              onClick={() => setViewMode("list")}
              title={t("providers.listView")}
            >
              <LayoutList size={13} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "tags" ? "active" : ""}`}
              onClick={() => setViewMode("tags")}
              title={t("providers.tagsView")}
            >
              <Tags size={13} />
            </button>
            <button
              type="button"
              className={`view-toggle-btn ${viewMode === "batch" ? "active" : ""}`}
              onClick={handleSwitchToBatch}
              title={t("providers.batchView")}
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
            {t("providers.batchEditHint")}
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
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => handleApplyBatch(rawBatchText)}
            >
              <Check size={13} />
              {t("providers.applyBatch")}
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
              placeholder={t("providers.addModelPlaceholder")}
            />
            <button
              type="button"
              className="provider-secondary-btn"
              disabled={!newModelId.trim()}
              onClick={() => handleAddModel(newModelId)}
            >
              <Plus size={14} />
              {t("providers.addModel")}
            </button>
          </div>

          {/* Search & Capability Filter Row */}
          {models.length > 0 && (
            <div className="model-mgr-controls">
              <div className="model-mgr-search-wrap">
                <Search size={14} className="model-mgr-search-icon" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  placeholder={t("providers.searchModels")}
                  className="model-mgr-search-input"
                />
                {searchText && (
                  <button
                    type="button"
                    className="model-mgr-search-clear"
                    onClick={() => setSearchText("")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              {/* Capability Tabs & Group Toggle Row */}
              <div className="model-mgr-filter-row">
                <div className="model-mgr-cap-tabs">
                  <button
                    type="button"
                    className={`cap-tab ${capFilter === "all" ? "active" : ""}`}
                    onClick={() => setCapFilter("all")}
                  >
                    {t("providers.capFilterAll")} ({counts.all})
                  </button>
                  <button
                    type="button"
                    className={`cap-tab ${capFilter === "reasoning" ? "active" : ""}`}
                    onClick={() => setCapFilter("reasoning")}
                  >
                    {t("providers.capFilterReasoning")} ({counts.reasoning})
                  </button>
                  <button
                    type="button"
                    className={`cap-tab ${capFilter === "tools" ? "active" : ""}`}
                    onClick={() => setCapFilter("tools")}
                  >
                    {t("providers.capFilterTools")} ({counts.tools})
                  </button>
                  <button
                    type="button"
                    className={`cap-tab ${capFilter === "vision" ? "active" : ""}`}
                    onClick={() => setCapFilter("vision")}
                  >
                    {t("providers.capFilterVision")} ({counts.vision})
                  </button>
                  <button
                    type="button"
                    className={`cap-tab ${capFilter === "code" ? "active" : ""}`}
                    onClick={() => setCapFilter("code")}
                  >
                    {t("providers.capFilterCode")} ({counts.code})
                  </button>
                </div>

                {/* Expand/Collapse All (for list view) */}
                {viewMode === "list" && (
                  <button
                    type="button"
                    className="model-mgr-group-toggle-all"
                    onClick={toggleAllGroups}
                    title={allExpanded ? t("providers.collapseAll") : t("providers.expandAll")}
                  >
                    {allExpanded ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Model Content Area */}
          {filteredModels.length === 0 ? (
            <div className="provider-models-empty-hint">
              {searchText || capFilter !== "all"
                ? t("providers.noFilterResults")
                : t("providers.noModelsFound")}
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
                      title={t("providers.configAdvanced")}
                    >
                      <Settings size={11} />
                    </button>
                    <button
                      type="button"
                      className="model-mgr-icon-btn del"
                      onClick={() => handleRemoveModel(m.id)}
                      title={t("providers.deleteModel")}
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
                                      <span>{t("providers.capFilterReasoning")}</span>
                                    </span>
                                  )}
                                  {caps.tools && (
                                    <span className="cap-pill tools">
                                      <Wrench size={11} />
                                      <span>{t("providers.capFilterTools")}</span>
                                    </span>
                                  )}
                                  {caps.vision && (
                                    <span className="cap-pill vision">
                                      <Eye size={11} />
                                      <span>{t("providers.capFilterVision")}</span>
                                    </span>
                                  )}
                                  {caps.code && (
                                    <span className="cap-pill code">
                                      <Code size={11} />
                                      <span>{t("providers.capFilterCode")}</span>
                                    </span>
                                  )}
                                  {ctxText && (
                                    <span className="spec-pill" title={t("providers.contextWindow")}>
                                      {ctxText} ctx
                                    </span>
                                  )}
                                  {maxText && (
                                    <span className="spec-pill out" title={t("providers.maxTokens")}>
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
                                  title={t("providers.copyModelId")}
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
                                  title={t("providers.configAdvanced")}
                                >
                                  <Settings size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="model-action-btn danger"
                                  onClick={() => handleRemoveModel(m.id)}
                                  title={t("providers.deleteModel")}
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
