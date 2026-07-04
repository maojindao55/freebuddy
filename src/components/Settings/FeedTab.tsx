import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Trash2 } from "lucide-react";

import { useFeedStore } from "@/store/feedStore";
import type { FeedSource } from "@/services/feed/types";

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
          <span className={`feed-source-status${source.enabled ? " enabled" : ""}`}>
            {source.enabled ? t("feed.enabled") : t("feed.disabled")}
          </span>
        </div>
        <div className="feed-source-url" title={source.url}>
          {source.url}
        </div>
        <div className="feed-source-meta">
          <span>
            {t("feed.lastFetched", {
              time: formatLastFetched(source.lastFetchedAt, t("feed.neverFetched"))
            })}
          </span>
          {source.lastError && <span className="warn">{source.lastError}</span>}
        </div>
      </div>
      <div className="feed-source-actions">
        <label className="feed-toggle">
          <input
            type="checkbox"
            checked={source.enabled}
            onChange={(event) => onToggle(event.currentTarget.checked)}
          />
          <span>{t("feed.enabled")}</span>
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
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [formError, setFormError] = useState("");

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  const handleAdd = async () => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) {
      setFormError(t("feed.urlRequired"));
      return;
    }
    setFormError("");
    try {
      const source = await addSource({
        title: title.trim() || undefined,
        url: trimmedUrl
      });
      setTitle("");
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

      <div className="feed-add-form">
        <label>
          <span>{t("feed.sourceName")}</span>
          <input
            value={title}
            placeholder={t("feed.sourceNamePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
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
          {t("feed.addSource")}
        </button>
      </div>

      {(formError || error) && (
        <p className="feed-error" role="alert">
          {formError || error}
        </p>
      )}

      <div className="feed-list-toolbar">
        <span>
          {loaded
            ? t("feed.sourceCount", { count: sources.length })
            : t("feed.loading")}
        </span>
        <button
          type="button"
          className="ghost"
          disabled={refreshing || sources.length === 0}
          onClick={() => void refreshAll()}
        >
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
    </div>
  );
}
