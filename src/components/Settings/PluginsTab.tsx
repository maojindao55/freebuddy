import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  AlertTriangle,
  Check,
  Download,
  Package,
  Plus,
  RefreshCw,
  Search,
  Store,
  Trash2,
  X
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { pluginsClient } from "@/services/plugins/client";
import type {
  NativePluginAgent,
  NativePluginRecord,
  NativePluginSnapshot
} from "@/services/plugins/types";
import { attachmentPreviewUrl } from "@/utils/chatAttachments";

type PluginView = "installed" | "available";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PluginIcon({ plugin }: { plugin: NativePluginRecord }) {
  const iconUrl = plugin.iconPath ? attachmentPreviewUrl(plugin.iconPath) : "";
  const darkIconUrl = plugin.iconPathDark ? attachmentPreviewUrl(plugin.iconPathDark) : "";
  const style = plugin.brandColor
    ? ({ "--plugin-brand-color": plugin.brandColor } as CSSProperties)
    : undefined;
  return (
    <div className="plugin-card-icon" style={style}>
      <Package className="plugin-card-icon-fallback" size={18} aria-hidden="true" />
      {iconUrl ? (
        <img
          className="plugin-card-logo plugin-card-logo-light"
          src={iconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
      {darkIconUrl ? (
        <img
          className="plugin-card-logo plugin-card-logo-dark"
          src={darkIconUrl}
          alt=""
          loading="lazy"
          decoding="async"
          onError={(event) => {
            event.currentTarget.style.display = "none";
          }}
        />
      ) : null}
    </div>
  );
}

export function PluginsTab() {
  const { t } = useTranslation();
  const [agent, setAgent] = useState<NativePluginAgent>("codex");
  const [snapshot, setSnapshot] = useState<NativePluginSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [view, setView] = useState<PluginView>("installed");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [marketplaceDialogOpen, setMarketplaceDialogOpen] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const addMarketplaceButtonRef = useRef<HTMLButtonElement>(null);
  const marketplaceDialogRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (target: NativePluginAgent = agent) => {
    setLoading(true);
    setError("");
    try {
      setSnapshot(await pluginsClient.list(target));
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [agent]);

  useEffect(() => {
    setSnapshot(undefined);
    setQuery("");
    setView("installed");
    setMarketplaceDialogOpen(false);
    setMarketplaceSource("");
    void load(agent);
  }, [agent, load]);

  const plugins = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (snapshot?.plugins ?? []).filter((plugin) => {
      if (view === "installed" && !plugin.installed) return false;
      if (view === "available" && plugin.installed) return false;
      if (!needle) return true;
      return `${plugin.displayName ?? ""} ${plugin.name} ${plugin.id} ${plugin.description ?? ""} ${plugin.marketplace ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
  }, [query, snapshot?.plugins, view]);

  const runAction = async (key: string, action: () => Promise<unknown>): Promise<boolean> => {
    setBusyKey(key);
    setError("");
    try {
      await action();
      await load(agent);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusyKey("");
    }
  };

  const install = (plugin: NativePluginRecord) =>
    runAction(`install:${plugin.id}`, () =>
      pluginsClient.install({ agent, pluginId: plugin.id, scope: "user" })
    );

  const update = (plugin: NativePluginRecord) =>
    runAction(`update:${plugin.id}`, () =>
      pluginsClient.update({
        agent,
        pluginId: plugin.id,
        marketplace: plugin.marketplace,
        scope: "user"
      })
    );

  const uninstall = (plugin: NativePluginRecord) => {
    const name = plugin.displayName ?? plugin.name;
    if (!window.confirm(t("plugins.uninstallConfirm", { name }))) return;
    void runAction(`uninstall:${plugin.id}`, () =>
      pluginsClient.uninstall({ agent, pluginId: plugin.id, scope: "user" })
    );
  };

  const closeMarketplaceDialog = () => {
    if (busyKey === "marketplace:add") return;
    setMarketplaceDialogOpen(false);
    setMarketplaceSource("");
    requestAnimationFrame(() => addMarketplaceButtonRef.current?.focus());
  };

  const addMarketplace = async () => {
    const source = marketplaceSource.trim();
    if (!source) return;
    const added = await runAction("marketplace:add", () =>
      pluginsClient.addMarketplace({ agent, source, scope: "user" })
    );
    if (added) {
      setMarketplaceSource("");
      setMarketplaceDialogOpen(false);
      requestAnimationFrame(() => addMarketplaceButtonRef.current?.focus());
    }
  };

  const handleMarketplaceDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMarketplaceDialog();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = marketplaceDialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const removeMarketplace = (marketplace: string) => {
    if (!window.confirm(t("plugins.removeMarketplaceConfirm", { name: marketplace }))) return;
    void runAction(`marketplace:remove:${marketplace}`, () =>
      pluginsClient.removeMarketplace({ agent, marketplace })
    );
  };

  return (
    <section className="settings-tab plugins-tab">
      <div className="plugins-heading">
        <div>
          <h3>{t("plugins.title")}</h3>
          <p className="muted">{t("plugins.description")}</p>
        </div>
        <div className="plugins-heading-actions">
          {snapshot?.available ? (
            <button
              ref={addMarketplaceButtonRef}
              type="button"
              className="secondary"
              disabled={loading || Boolean(busyKey)}
              aria-haspopup="dialog"
              aria-expanded={marketplaceDialogOpen}
              onClick={() => {
                setError("");
                setMarketplaceDialogOpen(true);
              }}
            >
              <Plus size={15} />
              {t("plugins.addMarketplace")}
            </button>
          ) : null}
          <button
            type="button"
            className="secondary plugins-refresh"
            disabled={loading || Boolean(busyKey)}
            onClick={() => void load(agent)}
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
            {t("plugins.refresh")}
          </button>
        </div>
      </div>

      <div className="plugins-agent-switch" role="tablist" aria-label={t("plugins.agentLabel")}>
        {(["codex", "claude"] as const).map((entry) => (
          <button
            key={entry}
            type="button"
            role="tab"
            className={agent === entry ? "active" : ""}
            aria-selected={agent === entry}
            onClick={() => setAgent(entry)}
          >
            {entry === "codex" ? "Codex" : "Claude"}
          </button>
        ))}
      </div>

      {error ? (
        <div className="plugins-notice error" role="alert">
          <AlertTriangle size={17} />
          <span>{error}</span>
        </div>
      ) : null}

      {!loading && snapshot && !snapshot.available ? (
        <div className="plugins-empty-state">
          <Package size={30} />
          <strong>{t("plugins.cliUnavailable", { agent: snapshot.label })}</strong>
          <span>{snapshot.error || t("plugins.cliUnavailableHint", { agent: snapshot.label })}</span>
        </div>
      ) : null}

      {!loading && snapshot?.available ? (
        <div className="plugins-workspace">
          <aside className="plugins-marketplaces">
            <div className="plugins-section-title">
              <Store size={16} />
              <strong>{t("plugins.marketplaces")}</strong>
              <span>{snapshot.marketplaces.length}</span>
            </div>
            <div className="plugins-marketplace-list">
              {snapshot.marketplaces.map((marketplace) => (
                <div className="plugins-marketplace-row" key={marketplace.name}>
                  <div>
                    <strong>{marketplace.name}</strong>
                    <span title={marketplace.source || marketplace.root}>
                      {marketplace.source || marketplace.root || t("plugins.localMarketplace")}
                    </span>
                  </div>
                  <div className="plugins-marketplace-actions">
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={Boolean(busyKey)}
                      onClick={() => void runAction(`marketplace:update:${marketplace.name}`, () =>
                        pluginsClient.updateMarketplace({ agent, marketplace: marketplace.name })
                      )}
                      aria-label={t("plugins.updateMarketplace", { name: marketplace.name })}
                    >
                      <RefreshCw size={14} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn danger"
                      disabled={Boolean(busyKey)}
                      onClick={() => removeMarketplace(marketplace.name)}
                      aria-label={t("plugins.removeMarketplace", { name: marketplace.name })}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
              {!snapshot.marketplaces.length ? (
                <span className="muted">{t("plugins.noMarketplaces")}</span>
              ) : null}
            </div>
          </aside>

          <div className="plugins-catalog">
            <div className="plugins-catalog-toolbar">
              <div className="plugins-view-tabs" role="tablist" aria-label={t("plugins.viewsLabel")}>
                <button
                  type="button"
                  role="tab"
                  className={view === "installed" ? "active" : ""}
                  onClick={() => setView("installed")}
                >
                  {t("plugins.installed", {
                    count: snapshot.plugins.filter((plugin) => plugin.installed).length
                  })}
                </button>
                <button
                  type="button"
                  role="tab"
                  className={view === "available" ? "active" : ""}
                  onClick={() => setView("available")}
                >
                  {t("plugins.available", {
                    count: snapshot.plugins.filter((plugin) => !plugin.installed).length
                  })}
                </button>
              </div>
              <label className="plugins-search">
                <Search size={15} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  placeholder={t("plugins.search")}
                  aria-label={t("plugins.search")}
                />
              </label>
            </div>

            <div className="plugins-list" aria-label={t("plugins.listLabel")}>
              {plugins.map((plugin) => {
                const installing = busyKey === `install:${plugin.id}`;
                const updating = busyKey === `update:${plugin.id}`;
                const uninstalling = busyKey === `uninstall:${plugin.id}`;
                return (
                  <article className="plugin-card" key={plugin.id}>
                    <PluginIcon plugin={plugin} />
                    <div className="plugin-card-copy">
                      <div className="plugin-card-title">
                        <strong>{plugin.displayName ?? plugin.name}</strong>
                        {plugin.version ? <span>v{plugin.version}</span> : null}
                        {!plugin.enabled && plugin.installed ? (
                          <span className="plugin-disabled">{t("plugins.disabled")}</span>
                        ) : null}
                      </div>
                      <p>{plugin.description || t("plugins.noDescription")}</p>
                      <small>{plugin.marketplace || plugin.source || plugin.id}</small>
                    </div>
                    <div className="plugin-card-actions">
                      {plugin.installed && plugin.managedBy === "desktop" ? (
                        <span
                          className="plugin-desktop-managed"
                          title={t("plugins.desktopManaged")}
                          aria-label={t("plugins.desktopManaged")}
                        >
                          <Check size={17} aria-hidden="true" />
                        </span>
                      ) : plugin.installed ? (
                        <>
                          <button
                            type="button"
                            className="secondary"
                            disabled={Boolean(busyKey)}
                            onClick={() => void update(plugin)}
                          >
                            <RefreshCw size={14} className={updating ? "spin" : ""} />
                            {updating ? t("plugins.updating") : t("plugins.update")}
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger"
                            disabled={Boolean(busyKey)}
                            onClick={() => uninstall(plugin)}
                            aria-label={t("plugins.uninstall", {
                              name: plugin.displayName ?? plugin.name
                            })}
                          >
                            <Trash2 size={15} className={uninstalling ? "spin" : ""} />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="primary"
                          disabled={Boolean(busyKey)}
                          onClick={() => void install(plugin)}
                        >
                          <Download size={14} className={installing ? "spin" : ""} />
                          {installing ? t("common.installing") : t("common.install")}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
              {!plugins.length ? (
                <div className="plugins-empty-list">{t("plugins.noResults")}</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {loading ? <div className="plugins-loading">{t("plugins.loading")}</div> : null}
      {snapshot?.available ? <p className="plugins-restart-note">{t("plugins.restartNote")}</p> : null}

      {marketplaceDialogOpen ? (
        <div
          className="modal-backdrop plugins-marketplace-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeMarketplaceDialog();
          }}
        >
          <div
            ref={marketplaceDialogRef}
            className="modal plugins-marketplace-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="plugins-marketplace-dialog-title"
            aria-describedby="plugins-marketplace-dialog-description"
            onKeyDown={handleMarketplaceDialogKeyDown}
          >
            <div className="plugins-marketplace-dialog-header">
              <div>
                <h3 id="plugins-marketplace-dialog-title">{t("plugins.addMarketplace")}</h3>
                <p id="plugins-marketplace-dialog-description">
                  {t("plugins.addMarketplaceDescription")}
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                disabled={busyKey === "marketplace:add"}
                onClick={closeMarketplaceDialog}
                aria-label={t("common.close")}
              >
                <X size={17} />
              </button>
            </div>

            <label className="plugins-marketplace-dialog-field">
              <span>{t("plugins.marketplaceSource")}</span>
              <input
                autoFocus
                value={marketplaceSource}
                onChange={(event) => setMarketplaceSource(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addMarketplace();
                }}
                placeholder={t("plugins.marketplaceSourcePlaceholder")}
              />
              <small>{t("plugins.marketplaceSourceHint")}</small>
            </label>

            <div className="plugins-marketplace-dialog-security">
              <AlertTriangle size={17} aria-hidden="true" />
              <span>{t("plugins.securityNote")}</span>
            </div>

            {error ? (
              <div className="plugins-notice error" role="alert">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>{error}</span>
              </div>
            ) : null}

            <div className="plugins-marketplace-dialog-actions">
              <button
                type="button"
                className="secondary"
                disabled={busyKey === "marketplace:add"}
                onClick={closeMarketplaceDialog}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="primary"
                disabled={!marketplaceSource.trim() || Boolean(busyKey)}
                onClick={() => void addMarketplace()}
              >
                <Plus size={15} />
                {busyKey === "marketplace:add"
                  ? t("plugins.addingMarketplace")
                  : t("plugins.addMarketplace")}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
