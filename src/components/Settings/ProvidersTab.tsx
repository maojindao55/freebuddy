import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Power, RefreshCw, Cpu } from "lucide-react";
import { useProviderStore } from "@/store/providerStore";
import type { Provider } from "@/services/providers/types";
import { getModelBrand } from "@/services/providers/modelUtils";
import { ProviderEditor } from "./ProviderEditor";
import { ProviderBrandIcon } from "./ProviderBrandIcon";

export function ProvidersTab() {
  const { t } = useTranslation();
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const load = useProviderStore((s) => s.load);
  const refresh = useProviderStore((s) => s.refresh);
  const setEnabled = useProviderStore((s) => s.setEnabled);

  const [selectedId, setSelectedId] = useState<string | "new" | null>(null);
  const [error] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const sorted = useMemo(
    () => [...providers].sort((a, b) => (a.position ?? 100) - (b.position ?? 100)),
    [providers],
  );

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
              onClick={() => void refresh()}
              title={t("common.refresh")}
            >
              <RefreshCw size={13} />
            </button>
            <button
              type="button"
              className="providers-add-btn"
              onClick={() => setSelectedId("new")}
              title={t("providers.add")}
            >
              <Plus size={13} />
              <span>{t("providers.add")}</span>
            </button>
          </div>
        </div>

        {error ? <div className="providers-error">{error}</div> : null}

        <div className="providers-nav-list">
          {sorted.length === 0 ? (
            <div className="providers-sidebar-empty">
              <p>{t("providers.empty")}</p>
            </div>
          ) : (
            sorted.map((p) => {
              const brand = getModelBrand(p.name || p.id);
              const isSelected = selectedId === p.id;
              return (
                <div
                  key={p.id}
                  className={`providers-nav-item ${isSelected ? "selected" : ""} ${
                    p.enabled ? "" : "disabled"
                  }`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <ProviderBrandIcon
                    nameOrId={p.name || p.id}
                    size={28}
                    className="provider-item-brand"
                  />

                  <div className="provider-item-content">
                    <div className="provider-item-row-top">
                      <strong className="provider-item-name">{p.name}</strong>
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
                      className={`provider-switch-btn ${p.enabled ? "on" : "off"}`}
                      title={p.enabled ? t("providers.disable") : t("providers.enable")}
                      onClick={() => void setEnabled(p.id, !p.enabled)}
                    >
                      <Power size={11} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Right Detail Pane */}
      <main className="providers-detail-pane">
        {selectedId === "new" ? (
          <ProviderEditor
            key="new"
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
          <div className="providers-empty-state">
            <Cpu size={40} className="empty-icon" />
            <h3>{t("providers.selectPrompt")}</h3>
            <p>{t("providers.selectPromptDesc")}</p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setSelectedId("new")}
            >
              <Plus size={14} />
              <span>{t("providers.add")}</span>
            </button>
          </div>
        )}
      </main>
    </section>
  );
}
