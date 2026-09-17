import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useProviderStore } from "@/store/providerStore";

/** Provider picker for Agent BYOK: pick a provider key instead of typing it. */
export function ProviderSelect({ adapter, value, onChange }: {
  adapter: string;
  value?: string;
  onChange: (providerId: string | undefined) => void;
}) {
  const { t } = useTranslation();
  const providers = useProviderStore((s) => s.providers);
  const loaded = useProviderStore((s) => s.loaded);
  const load = useProviderStore((s) => s.load);
  const [custom, setCustom] = useState(!value);
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  const options = useMemo(() => {
    const base = adapter.replace(/^cli-/, "");
    return providers.filter((p) => {
      if (!p.enabled) return false;
      const protos = p.protocols?.length ? p.protocols : [p.protocol];
      if (base === "codex-acp" || base === "codex") {
        return protos.some((x) => x === "openai-chat" || x === "openai-responses" || x === "deepseek");
      }
      if (base === "claude-agent-acp" || base === "claude") {
        return protos.some((x) => x === "anthropic");
      }
      if (base === "dsh-acp") {
        return protos.some((x) => x === "deepseek" || x === "openai-chat");
      }
      return protos.some((x) => x === "openai-chat" || x === "openai-responses");
    });
  }, [providers, adapter]);
  const selected = options.find((p) => p.id === value);
  return (
    <div className="provider-select">
      <label>
        <span>{t("providers.useProvider")}</span>
        <select
          value={custom ? "" : (value ?? "")}
          onChange={(e) => {
            if (!e.target.value) { setCustom(true); onChange(undefined); }
            else { setCustom(false); onChange(e.target.value); }
          }}
        >
          <option value="">{t("providers.custom")}</option>
          {options.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.models.length} models{p.apiKeyPreview ? ` · ${p.apiKeyPreview}` : ""})
            </option>
          ))}
        </select>
      </label>
      {selected ? (
        <small className="provider-select-hint">
          {selected.baseUrl} · {t("providers.managedHint")}
        </small>
      ) : null}
    </div>
  );
}
