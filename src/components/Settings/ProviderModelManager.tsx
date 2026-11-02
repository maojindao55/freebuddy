import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
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
  MoreHorizontal,
  LayoutList,
  Tags,
  FileText,
  ToggleLeft,
  ToggleRight,
  CheckSquare,
  Square,
  MinusSquare,
  RefreshCw,
} from "lucide-react";
import type { ProviderModel } from "@/services/providers/types";
import {
  inferModelCapabilities,
  inferContextWindow,
  inferModelGroup,
  formatTokenCount,
} from "@/services/providers/modelUtils";
import { ModelConfigModal } from "./ModelConfigModal";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import "./ProviderModelManager.css";

interface ProviderModelManagerProps {
  models: ProviderModel[];
  onChange: (models: ProviderModel[]) => void;
  isDirty?: boolean;
  onSave?: () => void;
  saving?: boolean;
  toolbarActions?: React.ReactNode;
}

type CapabilityFilter = "all" | "reasoning" | "tools" | "vision" | "code";
type ViewMode = "list" | "tags" | "batch";

export const ProviderModelManager: React.FC<ProviderModelManagerProps> = ({
  models,
  onChange,
  isDirty,
  onSave,
  saving,
  toolbarActions,
}) => {
  const { t } = useTranslation();

  // Search & Filters
  const [searchText, setSearchText] = useState("");
  const [capFilter, setCapFilter] = useState<CapabilityFilter>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [newModelId, setNewModelId] = useState("");
  const [rawBatchText, setRawBatchText] = useState("");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);

  // Group expansion state: record of groupName -> boolean (true = collapsed)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (addModelOpen) addInputRef.current?.focus();
  }, [addModelOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const closeOnPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !moreRef.current?.contains(event.target)) {
        setMoreOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnPointer);
    return () => document.removeEventListener("pointerdown", closeOnPointer);
  }, [moreOpen]);

  const closeMore = () => {
    setMoreOpen(false);
    moreButtonRef.current?.focus();
  };

  const closeAddModel = () => {
    setAddModelOpen(false);
    addButtonRef.current?.focus();
  };

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMore();
      return;
    }
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  };

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
        enabled: false,
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

  // Toggle model enabled state
  const handleToggleModelEnabled = useCallback(
    (id: string) => {
      onChange(
        models.map((m) => {
          if (m.id === id) {
            return { ...m, enabled: m.enabled === false ? true : false };
          }
          return m;
        }),
      );
    },
    [models, onChange],
  );

  // Toggle all models enabled
  const handleToggleAll = useCallback(
    (enable: boolean) => {
      onChange(models.map((m) => ({ ...m, enabled: enable })));
    },
    [models, onChange],
  );

  // Toggle all models in a group
  const handleToggleGroup = useCallback(
    (groupName: string, enable: boolean) => {
      onChange(
        models.map((m) => {
          const g = inferModelGroup(m.id, m.group);
          if (g === groupName) {
            return { ...m, enabled: enable };
          }
          return m;
        }),
      );
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
        enabled: false,
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

  const enabledCount = useMemo(
    () => models.filter((m) => m.enabled !== false).length,
    [models],
  );
  const allExpanded = Object.keys(groupedModels).every((groupName) => !collapsedGroups[groupName]);

  return (
    <div className="provider-model-manager provider-model-manager-clean">
      <div className="model-mgr-toolbar">
        <div className="model-mgr-toolbar-left">
          <span className="model-mgr-count-badge">
            {t("providers.modelTotalCount")} ({models.length})
          </span>
          <span className={`model-mgr-enabled-badge ${enabledCount === 0 ? "zero" : ""}`}>
            {t("providers.modelEnabledSummary", { count: enabledCount })}
          </span>
          {filteredModels.length !== models.length && (
            <span className="model-mgr-filtered-badge">
              {t("providers.matchedCount", { count: filteredModels.length })}
            </span>
          )}
        </div>

        <div className="model-mgr-toolbar-right">
          {viewMode !== "batch" && toolbarActions}
          {isDirty && onSave && (
            <button
              type="button"
              className="provider-text-btn model-mgr-save-btn"
              onClick={onSave}
              disabled={saving}
              title={t("providers.saveChanges")}
            >
              {saving ? <RefreshCw size={13} className="spinning" /> : <Check size={13} />}
              <span>{saving ? t("common.saving") : t("providers.saveChanges")}</span>
            </button>
          )}
          {viewMode !== "batch" && (
            <button
              ref={addButtonRef}
              type="button"
              className="model-mgr-toolbar-btn"
              onClick={() => setAddModelOpen((open) => !open)}
              aria-expanded={addModelOpen}
            >
              <Plus size={14} />
              {t("providers.addModelAction")}
            </button>
          )}
          <div
            className="model-mgr-more"
            ref={moreRef}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMoreOpen(false);
            }}
          >
            <button
              ref={moreButtonRef}
              type="button"
              className={`model-mgr-toolbar-btn icon-only ${moreOpen ? "active" : ""}`}
              onClick={() => setMoreOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setMoreOpen(true);
                }
              }}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-label={t("providers.modelActions")}
              title={t("providers.modelActions")}
            >
              <MoreHorizontal size={17} />
            </button>
            {moreOpen && (
              <div className="model-mgr-more-menu" role="menu" ref={menuRef} onKeyDown={handleMenuKeyDown}>
                <button type="button" role="menuitem" disabled={!models.length || viewMode === "batch"} onClick={() => { handleToggleAll(enabledCount < models.length); closeMore(); }}>
                  {enabledCount === models.length ? <ToggleLeft size={14} /> : <ToggleRight size={14} />}
                  {enabledCount === models.length ? t("providers.disableAll") : t("providers.enableAll")}
                </button>
                <div className="model-mgr-menu-divider" role="separator" />
                <button type="button" role="menuitemradio" aria-checked={viewMode === "list"} onClick={() => { setViewMode("list"); closeMore(); }}>
                  <LayoutList size={14} />{t("providers.listView")}{viewMode === "list" && <Check size={13} className="model-mgr-menu-check" />}
                </button>
                <button type="button" role="menuitemradio" aria-checked={viewMode === "tags"} onClick={() => { setViewMode("tags"); closeMore(); }}>
                  <Tags size={14} />{t("providers.tagsView")}{viewMode === "tags" && <Check size={13} className="model-mgr-menu-check" />}
                </button>
                <button type="button" role="menuitem" onClick={() => { handleSwitchToBatch(); closeMore(); }}>
                  <FileText size={14} />{t("providers.batchView")}
                </button>
                <div className="model-mgr-menu-divider" role="separator" />
                <button type="button" role="menuitem" className="danger" disabled={!models.length || viewMode === "batch"} onClick={() => { onChange([]); closeMore(); }}>
                  <Trash2 size={14} />{t("providers.clearModels")}
                </button>
              </div>
            )}
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
            aria-label={t("providers.batchView")}
            placeholder="gpt-4o&#10;claude-3-7-sonnet&#10;deepseek-chat&#10;deepseek-reasoner"
          />
          <div className="model-mgr-batch-actions">
            <button
              type="button"
              className="provider-header-btn secondary btn-sm"
              onClick={() => setViewMode("list")}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="provider-header-btn primary btn-sm"
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
          {addModelOpen && <div className="provider-model-input-row model-mgr-add-row">
            <input
              ref={addInputRef}
              value={newModelId}
              onChange={(e) => setNewModelId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleAddModel(newModelId);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  closeAddModel();
                }
              }}
              placeholder={t("providers.addModelPlaceholder")}
              aria-label={t("providers.addModelAction")}
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
            <button type="button" className="model-mgr-toolbar-btn icon-only" onClick={closeAddModel} aria-label={t("common.cancel")}>
              <X size={14} />
            </button>
          </div>}

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
                  aria-label={t("providers.searchModels")}
                  className="model-mgr-search-input"
                />
                {searchText && (
                  <button
                    type="button"
                    className="model-mgr-search-clear"
                    onClick={() => setSearchText("")}
                    aria-label={t("providers.clearModelSearch")}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>

              <div className="model-mgr-filter-row">
                <select
                  className="model-mgr-cap-select"
                  value={capFilter}
                  onChange={(event) => setCapFilter(event.target.value as CapabilityFilter)}
                  aria-label={t("providers.filterModelCapabilities")}
                >
                  <option value="all">{t("providers.allCapabilities")} ({counts.all})</option>
                  <option value="reasoning">{t("providers.capFilterReasoning")} ({counts.reasoning})</option>
                  <option value="tools">{t("providers.capFilterTools")} ({counts.tools})</option>
                  <option value="vision">{t("providers.capFilterVision")} ({counts.vision})</option>
                  <option value="code">{t("providers.capFilterCode")} ({counts.code})</option>
                </select>
                {viewMode === "list" && (
                  <button
                    type="button"
                    className="model-mgr-group-toggle-all"
                    onClick={toggleAllGroups}
                    title={allExpanded ? t("providers.collapseAll") : t("providers.expandAll")}
                    aria-label={allExpanded ? t("providers.collapseAll") : t("providers.expandAll")}
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
                const caps = inferModelCapabilities(m.id, {
                  supportsReasoning: m.supportsReasoning,
                  supportsTools: m.supportsTools,
                  supportsVision: m.supportsVision,
                });
                return (
                  <div key={m.id} className={`model-mgr-tag-card ${m.enabled === false ? "disabled" : ""}`}>
                    <label
                      className="model-toggle-switch mini"
                      title={m.enabled !== false ? t("providers.modelEnabled") : t("providers.modelDisabled")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        aria-label={`${m.name || m.id} · ${t("providers.modelEnabled")}`}
                        checked={m.enabled !== false}
                        onChange={() => handleToggleModelEnabled(m.id)}
                      />
                      <span className="model-toggle-slider" />
                    </label>
                    <ProviderBrandIcon
                      nameOrId={m.id}
                      size={16}
                      className="model-tag-brand-avatar"
                    />
                    <code className="model-tag-name" title={m.id}>{m.name || m.id}</code>
                    <div className="model-tag-badges">
                      {caps.reasoning && <span title={t("providers.capFilterReasoning")}><Brain size={12} /></span>}
                      {caps.tools && <span title={t("providers.capFilterTools")}><Wrench size={12} /></span>}
                      {caps.vision && <span title={t("providers.capFilterVision")}><Eye size={12} /></span>}
                    </div>
                    <button
                      type="button"
                      className="model-mgr-icon-btn edit"
                      onClick={() => setConfigModel(m)}
                      title={t("providers.configAdvanced")}
                      aria-label={`${t("providers.configAdvanced")}: ${m.name || m.id}`}
                    >
                      <Settings size={11} />
                    </button>
                    <button
                      type="button"
                      className="model-mgr-icon-btn del"
                      onClick={() => handleRemoveModel(m.id)}
                      title={t("providers.deleteModel")}
                      aria-label={`${t("providers.deleteModel")}: ${m.name || m.id}`}
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
                    <div className="model-mgr-group-header">
                      <button
                        type="button"
                        className="model-mgr-group-title"
                        onClick={() => toggleGroup(groupName)}
                        aria-expanded={!isCollapsed}
                      >
                        {isCollapsed ? (
                           <ChevronRight size={14} className="group-arrow" />
                        ) : (
                          <ChevronDown size={14} className="group-arrow" />
                        )}
                        <span className="group-name">{groupName}</span>
                        <span className="group-count">({groupList.length})</span>
                        <span className="group-enabled-count">
                          · {t("providers.modelEnabledSummary", {
                            count: groupList.filter((m) => m.enabled !== false).length,
                          })}
                        </span>
                      </button>
                      <div
                        className="model-mgr-group-actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(() => {
                          const grpActive = groupList.filter((m) => m.enabled !== false).length;
                          const allOn = grpActive === groupList.length;
                          return (
                            <button
                              type="button"
                              className={`model-group-switch-btn ${grpActive > 0 ? "active" : ""}`}
                              onClick={() => handleToggleGroup(groupName, !allOn)}
                              title={allOn ? t("providers.disableGroup") : t("providers.enableGroup")}
                            >
                              {allOn ? (
                                <CheckSquare size={13} />
                              ) : grpActive > 0 ? (
                                <MinusSquare size={13} />
                              ) : (
                                <Square size={13} />
                              )}
                              <span>{allOn ? t("providers.disableGroup") : t("providers.enableGroup")}</span>
                            </button>
                          );
                        })()}
                      </div>
                    </div>

                    {/* Group Items */}
                    {!isCollapsed && (
                      <div className="model-mgr-group-body">
                        {groupList.map((m) => {
                          const caps = inferModelCapabilities(m.id, {
                            supportsReasoning: m.supportsReasoning,
                            supportsTools: m.supportsTools,
                            supportsVision: m.supportsVision,
                          });
                          const ctxText = formatTokenCount(m.contextWindow);
                          const maxText = formatTokenCount(m.maxTokens);
                          const isCopied = copiedId === m.id;

                          return (
                            <div key={m.id} className={`model-mgr-row-card ${m.enabled === false ? "disabled" : ""}`}>
                              {/* Left: Brand Avatar + Name / ID */}
                              <div className="model-row-left">
                                <ProviderBrandIcon
                                  nameOrId={m.id}
                                  size={26}
                                  className="model-row-avatar"
                                />
                                <div className="model-row-info" title={m.id}>
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
                                    <span className="cap-pill reasoning" title={t("providers.capFilterReasoning")}>
                                      <Brain size={11} />
                                      <span>{t("providers.capFilterReasoning")}</span>
                                    </span>
                                  )}
                                  {caps.tools && (
                                    <span className="cap-pill tools" title={t("providers.capFilterTools")}>
                                      <Wrench size={11} />
                                      <span>{t("providers.capFilterTools")}</span>
                                    </span>
                                  )}
                                  {caps.vision && (
                                    <span className="cap-pill vision" title={t("providers.capFilterVision")}>
                                      <Eye size={11} />
                                      <span>{t("providers.capFilterVision")}</span>
                                    </span>
                                  )}
                                  {caps.code && (
                                    <span className="cap-pill code" title={t("providers.capFilterCode")}>
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
                                <label
                                  className="model-toggle-switch"
                                  title={m.enabled !== false ? t("providers.modelEnabled") : t("providers.modelDisabled")}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={`${m.name || m.id} · ${t("providers.modelEnabled")}`}
                                    checked={m.enabled !== false}
                                    onChange={() => handleToggleModelEnabled(m.id)}
                                  />
                                  <span className="model-toggle-slider" />
                                </label>
                                <button
                                  type="button"
                                  className="model-action-btn"
                                  onClick={() => handleCopy(m.id)}
                                  title={t("providers.copyModelId")}
                                  aria-label={`${t("providers.copyModelId")}: ${m.id}`}
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
                                  aria-label={`${t("providers.configAdvanced")}: ${m.name || m.id}`}
                                >
                                  <Settings size={13} />
                                </button>
                                <button
                                  type="button"
                                  className="model-action-btn danger"
                                  onClick={() => handleRemoveModel(m.id)}
                                  title={t("providers.deleteModel")}
                                  aria-label={`${t("providers.deleteModel")}: ${m.name || m.id}`}
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

      {/* Unsaved state is surfaced by the editor header status pill (auto-save
          is enabled for existing providers), so no sticky bar here. */}

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
