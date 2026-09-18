import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy, Pencil, Plus, Power, RefreshCw, Trash2 } from "lucide-react";
import { useProviderStore } from "@/store/providerStore";
import { providersClient } from "@/services/providers/client";
import { copyToClipboard } from "@/utils/clipboard";
import type { Provider } from "@/services/providers/types";
import { ProviderEditor } from "./ProviderEditor";

export function ProvidersTab() {
  const { t } = useTranslation();
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const load = useProviderStore((s) => s.load);
  const refresh = useProviderStore((s) => s.refresh);
  const remove = useProviderStore((s) => s.remove);
  const setEnabled = useProviderStore((s) => s.setEnabled);
  const [editing, setEditing] = useState<Provider | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);

  const onCopyKey = useCallback(async (p: Provider) => {
    try {
      const key = await providersClient.getApiKey(p.id);
      if (key) {
        await copyToClipboard(key);
        setCopiedId(p.id);
        setTimeout(() => setCopiedId(null), 2000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const sorted = useMemo(
    () => [...providers].sort((a, b) => (a.position ?? 100) - (b.position ?? 100)),
    [providers],
  );
  const onTest = useCallback(async (p: Provider) => {
    setTestingId(p.id); setError("");
    try { await providersClient.test(p.id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setTestingId(null); }
  }, [refresh]);
  const onDelete = useCallback(async (p: Provider) => {
    if (!window.confirm(t("providers.deleteConfirm", { name: p.name }))) return;
    try { await remove(p.id); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [remove, t]);
  return (
    <section className="providers-tab">
      <header className="providers-tab-header">
        <div>
          <h3>{t("providers.title")}</h3>
          <p className="providers-tab-desc">{t("providers.description")}</p>
        </div>
        <div className="providers-tab-actions">
          <button type="button" className="secondary" onClick={() => void refresh()}>
            <RefreshCw size={14} aria-hidden="true" />{t("common.refresh")}
          </button>
          <button type="button" className="primary" onClick={() => setEditing("new")}>
            <Plus size={14} aria-hidden="true" />{t("providers.add")}
          </button>
        </div>
      </header>
      {error ? <div className="providers-error" role="alert">{error}</div> : null}
      {sorted.length === 0 ? (
        <div className="providers-empty"><p>{t("providers.empty")}</p></div>
      ) : (
        <ul className="providers-list">
          {sorted.map((p) => (
            <li key={p.id} className={`provider-card${p.enabled ? "" : " disabled"}`}>
              <div className="provider-card-main">
                <div className="provider-card-title">
                  <strong>{p.name}</strong>
                  <span className="provider-protocol">{p.protocol}</span>
                  {p.protocols && p.protocols.length > 1 ? (
                    <span className="provider-protocol-extra" title={p.protocols.join(", ")}>
                      +{p.protocols.length - 1}
                    </span>
                  ) : null}
                  {p.lastHealth === "ok" ? (
                    <span className="provider-health-badge ok" title={p.lastCheckedAt}>
                      <span className="provider-health-dot" />
                      {p.lastLatencyMs ? `${p.lastLatencyMs}ms` : t("providers.statusOk")}
                    </span>
                  ) : p.lastHealth === "error" ? (
                    <span className="provider-health-badge error" title={p.lastError || p.lastCheckedAt}>
                      <span className="provider-health-dot" />
                      {p.lastError ? p.lastError.slice(0, 24) : t("providers.statusError")}
                    </span>
                  ) : null}
                </div>
                <div className="provider-card-meta">
                  <code>{p.baseUrl}</code><span>·</span>
                  <span>{t("providers.modelsCount", { count: p.models.length })}</span>
                  {p.apiKeyPreview ? (
                    <>
                      <span>·</span>
                      <span className="provider-card-key-pill">
                        <code>{p.apiKeyPreview}</code>
                        <button
                          type="button"
                          className="provider-card-copy-key-btn"
                          title={copiedId === p.id ? t("providers.keyCopied") : t("providers.copyKey")}
                          onClick={() => void onCopyKey(p)}
                        >
                          {copiedId === p.id ? (
                            <Check size={11} className="copied-icon" />
                          ) : (
                            <Copy size={11} />
                          )}
                        </button>
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
              <div className="provider-card-actions">
                <button
                  type="button"
                  className={`icon-btn${p.enabled ? " active" : ""}`}
                  title={p.enabled ? t("providers.disable") : t("providers.enable")}
                  onClick={() => void setEnabled(p.id, !p.enabled)}
                >
                  <Power size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("providers.testConnection")}
                  disabled={testingId === p.id}
                  onClick={() => void onTest(p)}
                >
                  <RefreshCw size={15} className={testingId === p.id ? "spinning" : ""} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={t("providers.edit")}
                  onClick={() => setEditing(p)}
                >
                  <Pencil size={15} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title={t("common.delete")}
                  onClick={() => void onDelete(p)}
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing ? (
        <ProviderEditor
          initial={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
