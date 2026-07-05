import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, RefreshCw, Trash2 } from "lucide-react";

import { cliClient } from "@/services/cli/client";
import { useFeedStore } from "@/store/feedStore";
import type { FeedSource } from "@/services/feed/types";

const RSSHUB_BASE_URL_SETTING_KEY = "feed.rsshubBaseUrl";
const RSSHUB_DEFAULT_BASE_URL = "https://rsshub.app";

function formatLastFetched(value: string | undefined, fallback: string) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function FeedSourceRow({
  source,
  refreshing,
  onRefresh,
  onToggle,
  onDelete
}: {
  source: FeedSource;
  refreshing: boolean;
  onRefresh: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="feed-source-row">
      <div className="feed-source-main">
        <div className="feed-source-title">
          <strong>{source.title}</strong>
        </div>
        <div className="feed-source-details">
          <span className="feed-source-url" title={source.url}>
            {source.url}
          </span>
          <span>
            {t("feed.lastFetched", {
              time: formatLastFetched(source.lastFetchedAt, t("feed.neverFetched"))
            })}
          </span>
          {source.lastError && (
            <span className="feed-source-error">{source.lastError}</span>
          )}
        </div>
      </div>
      <div className="feed-source-actions">
        <label className="feed-switch" title={source.enabled ? t("feed.enabled") : t("feed.disabled")}>
          <input
            type="checkbox"
            aria-label={source.enabled ? t("feed.enabled") : t("feed.disabled")}
            checked={source.enabled}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          <span aria-hidden="true" />
        </label>
        <button
          type="button"
          className="icon-btn"
          title={t("feed.refreshOne")}
          aria-label={t("feed.refreshOne")}
          disabled={refreshing || !source.enabled}
          onClick={onRefresh}
        >
          <RefreshCw size={15} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className="icon-btn danger"
          title={t("common.delete")}
          aria-label={t("common.delete")}
          onClick={onDelete}
        >
          <Trash2 size={15} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

export function FeedTab() {
  const { t } = useTranslation();
  const loaded = useFeedStore((s) => s.loaded);
  const loading = useFeedStore((s) => s.loading);
  const refreshing = useFeedStore((s) => s.refreshing);
  const error = useFeedStore((s) => s.error);
  const sources = useFeedStore((s) => s.sources);
  const load = useFeedStore((s) => s.load);
  const addSource = useFeedStore((s) => s.addSource);
  const updateSource = useFeedStore((s) => s.updateSource);
  const deleteSource = useFeedStore((s) => s.deleteSource);
  const refreshSource = useFeedStore((s) => s.refreshSource);
  const refreshAll = useFeedStore((s) => s.refreshAll);
  const [url, setUrl] = useState("");
  const [rsshubBaseUrl, setRsshubBaseUrl] = useState(RSSHUB_DEFAULT_BASE_URL);
  const [rsshubSaving, setRsshubSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const enabledCount = sources.filter((source) => source.enabled).length;
  const errorCount = sources.filter((source) => Boolean(source.lastError)).length;
  const neverFetchedCount = sources.filter((source) => !source.lastFetchedAt).length;

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!cliClient.isAvailable()) return;
    void cliClient.getSetting(RSSHUB_BASE_URL_SETTING_KEY).then((stored) => {
      setRsshubBaseUrl(stored?.trim() || RSSHUB_DEFAULT_BASE_URL);
    });
  }, []);

  const handleSaveRsshubBaseUrl = async () => {
    const trimmed = rsshubBaseUrl.trim() || RSSHUB_DEFAULT_BASE_URL;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(t("feed.rsshubBaseUrlInvalid"));
      }
      const normalized = parsed.toString().replace(/\/$/, "");
      setRsshubSaving(true);
      setFormError("");
      await cliClient.setSetting(RSSHUB_BASE_URL_SETTING_KEY, normalized);
      setRsshubBaseUrl(normalized);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setRsshubSaving(false);
    }
  };

  const handleAdd = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setFormError(t("feed.urlRequired"));
      return;
    }
    setFormError("");
    try {
      const source = await addSource({
        url: trimmedUrl
      });
      setUrl("");
      void refreshSource(source.id);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings-tab feed-settings-tab">
      <div className="settings-section-heading">
        <h3 className="settings-section-title">{t("feed.settingsTitle")}</h3>
        <span className="settings-section-desc">
          {t("feed.settingsDescription")}
        </span>
      </div>

      <section className="feed-settings-section feed-add-section">
        <div className="feed-section-copy">
          <strong>{t("feed.addSourceTitle")}</strong>
          <span>{t("feed.addSourceHint")}</span>
        </div>
        <div className="feed-add-form">
          <label className="feed-url-field">
            <span>{t("feed.sourceUrl")}</span>
            <input
              value={url}
              placeholder={t("feed.sourceUrlPlaceholder")}
              onChange={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void handleAdd();
                }
              }}
            />
          </label>
          <button
            type="button"
            className="primary-btn"
            disabled={loading}
            onClick={() => void handleAdd()}
          >
            <Plus size={15} strokeWidth={2} />
            {t("feed.addSource")}
          </button>
        </div>
        <details className="feed-advanced">
          <summary>
            <span>{t("feed.rsshubSectionTitle")}</span>
            <small>{rsshubBaseUrl}</small>
          </summary>
          <div className="feed-rsshub-settings">
            <label>
              <span>{t("feed.rsshubBaseUrl")}</span>
              <input
                value={rsshubBaseUrl}
                placeholder={RSSHUB_DEFAULT_BASE_URL}
                onChange={(event) => setRsshubBaseUrl(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void handleSaveRsshubBaseUrl();
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="ghost"
              disabled={rsshubSaving}
              onClick={() => void handleSaveRsshubBaseUrl()}
            >
              {rsshubSaving ? t("feed.rsshubSaving") : t("feed.rsshubSave")}
            </button>
            <p>{t("feed.rsshubBaseUrlHelp")}</p>
            <code>{t("feed.rsshubRouteExample")}</code>
          </div>
        </details>
      </section>

      {(formError || error) && (
        <p className="feed-error" role="alert">
          {formError || error}
        </p>
      )}

      <section className="feed-settings-section">
        <div className="feed-list-toolbar">
          <div>
            <strong>{t("feed.sourcesTitle")}</strong>
            <span>
              {loaded
                ? t("feed.sourceCount", { count: sources.length })
                : t("feed.loading")}
            </span>
            {loaded && (
              <span className="feed-source-summary">
                {t("feed.enabledSummary", { count: enabledCount })}
                {" · "}
                {t("feed.errorSummary", { count: errorCount })}
                {" · "}
                {t("feed.neverFetchedSummary", { count: neverFetchedCount })}
              </span>
            )}
          </div>
          <button
            type="button"
            className="ghost"
            disabled={refreshing || sources.length === 0}
            onClick={() => void refreshAll()}
          >
            <RefreshCw size={14} strokeWidth={1.9} />
            {refreshing ? t("feed.refreshing") : t("feed.refreshAll")}
          </button>
        </div>

        <div className="feed-source-list">
          {sources.length === 0 ? (
            <p className="muted feed-empty">{t("feed.noSources")}</p>
          ) : (
            sources.map((source) => (
              <FeedSourceRow
                key={source.id}
                source={source}
                refreshing={refreshing}
                onRefresh={() => void refreshSource(source.id)}
                onToggle={(enabled) =>
                  void updateSource({ id: source.id, enabled })
                }
                onDelete={() => {
                  if (window.confirm(t("feed.deleteConfirm", { title: source.title }))) {
                    void deleteSource(source.id);
                  }
                }}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}
