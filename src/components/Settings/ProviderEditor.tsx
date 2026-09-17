import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProviderStore } from "@/store/providerStore";
import type { Provider } from "@/services/providers/types";
import {
  defaultEnvKeyForProtocol,
  protocolsOf,
  type ProviderProtocol,
} from "@/services/providers/types";

const PROTOCOLS: ProviderProtocol[] = ["openai-chat", "openai-responses", "anthropic", "deepseek"];

export function ProviderEditor({ initial, onClose, onSaved }: {
  initial?: Provider; onClose: () => void; onSaved: () => void;
}) {
  const { t } = useTranslation();
  const upsert = useProviderStore((s) => s.upsert);
  const [name, setName] = useState(initial?.name ?? "");
  const [protocol, setProtocol] = useState<ProviderProtocol>(initial?.protocol ?? "openai-chat");
  const [extraProtocols, setExtraProtocols] = useState<ProviderProtocol[]>(() =>
    protocolsOf(initial ?? { protocol: "openai-chat" }).filter((p) => p !== (initial?.protocol ?? "openai-chat")),
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [envKey, setEnvKey] = useState(initial?.envKey ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState((initial?.models ?? []).map((m) => m.id).join("\n"));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const envPlaceholder = useMemo(() => defaultEnvKeyForProtocol(protocol), [protocol]);
  // Protocols drive everything: env var, wire API and which agents can use it.
  const selectedProtocols = useMemo(
    () => [protocol, ...extraProtocols.filter((p) => p !== protocol)],
    [protocol, extraProtocols],
  );
  const submit = async () => {
    setSaving(true); setError("");
    try {
      await upsert({
        id: initial?.id,
        presetId: initial?.presetId,
        name: name.trim(),
        protocol,
        protocols: selectedProtocols,
        baseUrl: baseUrl.trim(),
        envKey: envKey.trim() || envPlaceholder,
        apiKey: apiKey.trim() || undefined,
        models: models.split("\n").map((s) => s.trim()).filter(Boolean).map((id) => ({ id })),
        wireApi: protocol === "openai-responses" ? "responses" : "chat",
      });
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>{initial ? t("providers.edit") : t("providers.add")}</h3>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body provider-editor">
          <label>{t("providers.name")}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>{t("providers.protocol")}
            <select value={protocol} onChange={(e) => setProtocol(e.target.value as ProviderProtocol)}>
              {PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <fieldset className="provider-editor-protocols">
            <legend>{t("providers.alsoSupports")}</legend>
            {PROTOCOLS.filter((p) => p !== protocol).map((p) => (
              <label key={p} className="provider-editor-check">
                <input
                  type="checkbox"
                  checked={extraProtocols.includes(p)}
                  onChange={() =>
                    setExtraProtocols((prev) =>
                      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
                    )
                  }
                />
                <span>{p}</span>
              </label>
            ))}
            <small className="provider-editor-hint">{t("providers.alsoSupportsHint")}</small>
          </fieldset>
          <label>{t("providers.baseUrl")}<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://" /></label>
          <label>{t("providers.envKey")}<input value={envKey} onChange={(e) => setEnvKey(e.target.value)} placeholder={envPlaceholder} /></label>
          <label>{t("providers.apiKey")}
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
              placeholder={initial?.apiKeyPreview ? t("providers.savedKeyHint", { preview: initial.apiKeyPreview }) : "sk-..."} />
          </label>
          <label>{t("providers.models")}<textarea value={models} onChange={(e) => setModels(e.target.value)} rows={4} placeholder="gpt-4o&#10;claude-sonnet-4-5" /></label>
          {error ? <div className="providers-error">{error}</div> : null}
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>{t("common.cancel")}</button>
            <button type="button" className="primary" disabled={saving || !name.trim() || !baseUrl.trim()} onClick={() => void submit()}>
              {saving ? t("common.saving") : t("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
