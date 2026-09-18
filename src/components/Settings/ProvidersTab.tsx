import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  GripVertical,
  KeyRound,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  Search,
  X,
  Zap,
} from "lucide-react";
import { useProviderStore } from "@/store/providerStore";
import { providersClient } from "@/services/providers/client";
import type { Provider } from "@/services/providers/types";
import { getModelBrand } from "@/services/providers/modelUtils";
import { ProviderEditor } from "./ProviderEditor";
import { ProviderBrandIcon } from "./ProviderBrandIcon";
import { ProviderPresetPicker } from "./ProviderPresetPicker";

export function ProvidersTab() {
  const { t } = useTranslation();
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const load = useProviderStore((s) => s.load);
  const refresh = useProviderStore((s) => s.refresh);
  const setEnabled = useProviderStore((s) => s.setEnabled);
  const storeError = useProviderStore((s) => s.error);
  const applyHealth = useProviderStore((s) => s.applyHealth);
  const reorder = useProviderStore((s) => s.reorder);

  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [pendingPresetId, setPendingPresetId] = useState<string | undefined>(undefined);
  const [searchText, setSearchText] = useState("");
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [testingAll, setTestingAll] = useState(false);

  // Drag & drop ordering state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const sorted = useMemo(
    () => [...providers].sort((a, b) => (a.position ?? 100) - (b.position ?? 100)),
    [providers],
  );

  const filtered = useMemo(() => {
    let list = sorted;
    const q = searchText.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.baseUrl.toLowerCase().includes(q) ||
          p.models.some((m) => m.id.toLowerCase().includes(q)),
      );
    }
    if (onlyEnabled) list = list.filter((p) => p.enabled !== false);
    return list;
  }, [sorted, searchText, onlyEnabled]);

  // Auto-select first provider on initial load if none selected
  useEffect(() => {
    if (selectedId === null && sorted.length > 0) {
      setSelectedId(sorted[0].id);
    }
  }, [selectedId, sorted]);

  const selectedProvider = useMemo(() => {
    if (selectedId === "new") return undefined;
    return sorted.find((p) => p.id === selectedId);
  }, [selectedId, sorted]);

  const onSaved = useCallback(
    (saved: Provider) => {
      void refresh();
      setSelectedId(saved.id);
      setPendingPresetId(undefined);
    },
    [refresh],
  );

  const onDeleted = useCallback(
    (deletedId: string) => {
      void refresh();
      if (selectedId === deletedId) {
        const remaining = sorted.filter((p) => p.id !== deletedId);
        setSelectedId(remaining.length > 0 ? remaining[0].id : null);
      }
    },
    [refresh, selectedId, sorted],
  );

  const onPickPreset = useCallback((presetId: string | null) => {
    setPendingPresetId(presetId ?? undefined);
    setSelectedId("new");
  }, []);

  // Test the persisted (already saved) configuration of every provider and
  // patch each result into the store in place, so dots update one by one
  // without clobbering unsaved editor state via a full refresh.
  const onTestAll = useCallback(async () => {
    if (testingAll) return;
    setTestingAll(true);
    try {
      for (const p of sorted) {
        try {
          const res = await providersClient.test(p.id);
          applyHealth(p.id, {
            ok: res.ok,
            latencyMs: res.latencyMs,
            error: res.error,
            checkedAt: res.checkedAt,
          });
        } catch {
          applyHealth(p.id, {
            ok: false,
            latencyMs: 0,
            error: "unreachable",
            checkedAt: new Date().toISOString(),
          });
        }
      }
    } finally {
      setTestingAll(false);
    }
  }, [testingAll, sorted, applyHealth]);

  const onDropOn = useCallback(
    (targetId: string) => {
      const sourceId = dragIdRef.current;
      setDragId(null);
      setDropTargetId(null);
      dragIdRef.current = null;
      if (!sourceId || sourceId === targetId) return;
      const ids = sorted.map((p) => p.id);
      const from = ids.indexOf(sourceId);
      const to = ids.indexOf(targetId);
      if (from < 0 || to < 0) return;
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      void reorder(ids);
    },
    [sorted, reorder],
  );

  const renderList = () => {
    if (sorted.length === 0) {
      return (
        <div className="providers-sidebar-empty">
          <p>{t("providers.empty")}</p>
        </div>
      );
    }
    if (filtered.length === 0) {
      return (
        <div className="providers-sidebar-empty">
          <p>{t("providers.noMatch")}</p>
        </div>
      );
    }
    return filtered.map((p) => {
      const brand = getModelBrand(p.name || p.id);
      const isSelected = selectedId === p.id;
      const isEnabled = p.enabled !== false;
      const draggable = !searchText && !onlyEnabled;
      return (
        <div
          key={p.id}
          className={[
            "providers-nav-item",
            isSelected ? "selected" : "",
            !isEnabled ? "disabled" : "",
            dragId === p.id ? "dragging" : "",
            dropTargetId === p.id && dragId && dragId !== p.id ? "drop-target" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClick={() => setSelectedId(p.id)}
          draggable={draggable}
          onDragStart={
            draggable
              ? (e) => {
                  dragIdRef.current = p.id;
                  setDragId(p.id);
                  e.dataTransfer.effectAllowed = "move";
                }
              : undefined
          }
          onDragEnd={() => {
            dragIdRef.current = null;
            setDragId(null);
            setDropTargetId(null);
          }}
          onDragOver={
            draggable
              ? (e) => {
                  e.preventDefault();
                  if (dragIdRef.current && dragIdRef.current !== p.id) setDropTargetId(p.id);
                }
              : undefined
          }
          onDragLeave={() => {
            if (dropTargetId === p.id) setDropTargetId(null);
          }}
          onDrop={
            draggable
              ? (e) => {
                  e.preventDefault();
                  onDropOn(p.id);
                }
              : undefined
          }
        >
          {/* Always render the handle slot so the card layout stays identical
              whether or not dragging is enabled; hide it visually instead of
              unmounting to avoid the icon/text shifting. */}
          <span
            className={`provider-drag-handle ${draggable ? "" : "hidden"}`}
            title={draggable ? t("providers.dragToReorder") : undefined}
            aria-hidden={!draggable}
          >
            <GripVertical size={12} />
          </span>
          <ProviderBrandIcon
            nameOrId={p.name || p.presetId || p.id}
            lobeIconId={p.icon}
            size={28}
            className="provider-item-brand"
          />

          <div className="provider-item-content">
            <div className="provider-item-row-top">
              <strong className="provider-item-name">{p.name}</strong>
              {!p.hasKey ? (
                <span className="provider-nokey-badge" title={t("providers.noKeyHint")}>
                  <KeyRound size={10} />
                  <span>{t("providers.noKeyBadge")}</span>
                </span>
              ) : null}
              {p.lastHealth === "ok" ? (
                <span
                  className="provider-health-dot ok"
                  title={
                    p.lastLatencyMs
                      ? `${p.lastLatencyMs}ms`
                      : t("providers.statusOk")
                  }
                />
              ) : p.lastHealth === "error" ? (
                <span
                  className="provider-health-dot error"
                  title={p.lastError || t("providers.statusError")}
                />
              ) : (
                <span
                  className="provider-health-dot untested"
                  title={t("providers.untested")}
                />
              )}
            </div>
            <div className="provider-item-row-bottom">
              <span className="provider-item-proto">{p.protocol}</span>
              {p.protocols && p.protocols.length > 1 && (
                <span className="provider-item-extra-proto">
                  +{p.protocols.length - 1}
                </span>
              )}
              <span className="provider-item-model-count">
                {t("providers.modelsCount", { count: p.models.length })}
              </span>
            </div>
          </div>

          <div
            className="provider-item-quick-actions"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className={`provider-switch-btn ${isEnabled ? "on" : "off"}`}
              title={isEnabled ? t("providers.disable") : t("providers.enable")}
              onClick={() => void setEnabled(p.id, !isEnabled)}
            >
              <Power size={11} />
            </button>
          </div>
        </div>
      );
    });
  };

  return (
    <section className="providers-workspace">
      {/* Left Sidebar: Provider List */}
      <aside className="providers-sidebar">
        <div className="providers-sidebar-header">
          <div className="providers-sidebar-title">
            <h4>{t("providers.providerList")}</h4>
            <span className="providers-count-badge">{sorted.length}</span>
          </div>
          <div className="providers-sidebar-actions">
            <button
              type="button"
              className="icon-btn"
              onClick={() => void onTestAll()}
              disabled={testingAll || sorted.length === 0}
              title={t("providers.testAll")}
            >
              {testingAll ? <Loader2 size={13} className="spinning" /> : <Zap size={13} />}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => void refresh()}
              title={t("common.refresh")}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className="providers-add-btn"
              onClick={() => onPickPreset(null)}
              title={t("providers.add")}
            >
              <Plus size={13} />
              <span>{t("providers.add")}</span>
            </button>
          </div>
        </div>

        {sorted.length > 0 ? (
          <div className="providers-sidebar-filter">
            <div className="providers-search-box">
              <Search size={12} />
              <input
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t("providers.searchProviders")}
              />
              {searchText ? (
                <button
                  type="button"
                  className="providers-search-clear"
                  onClick={() => setSearchText("")}
                  title={t("common.cancel")}
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
            <button
              type="button"
              className={`providers-enabled-filter ${onlyEnabled ? "active" : ""}`}
              onClick={() => setOnlyEnabled((v) => !v)}
              title={t("providers.onlyEnabled")}
            >
              {onlyEnabled ? <Check size={12} /> : null}
              <span>{t("providers.onlyEnabled")}</span>
            </button>
          </div>
        ) : null}

        {storeError ? <div className="providers-error">{storeError}</div> : null}

        <div className="providers-nav-list">{renderList()}</div>
      </aside>

      {/* Right Detail Pane */}
      <main className="providers-detail-pane">
        {selectedId === "new" ? (
          <ProviderEditor
            key={pendingPresetId ?? "new"}
            presetId={pendingPresetId}
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        ) : selectedProvider ? (
          <ProviderEditor
            key={selectedProvider.id}
            initial={selectedProvider}
            onSaved={onSaved}
            onDeleted={onDeleted}
          />
        ) : (
          <div className="providers-empty-state providers-empty-state-wide">
            <h3>{t("providers.selectPrompt")}</h3>
            <p>{t("providers.selectPromptDesc")}</p>
            <ProviderPresetPicker onPick={onPickPreset} />
          </div>
        )}
      </main>
    </section>
  );
}
