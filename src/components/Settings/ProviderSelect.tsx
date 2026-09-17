import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useProviderStore } from "@/store/providerStore";
import { isProviderCompatibleWithAdapter } from "@/services/providers/types";

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
  useEffect(() => { if (!loaded) void load(); }, [loaded, load]);
  const options = useMemo(
    () =>
      providers.filter(
        (p) => p.enabled && isProviderCompatibleWithAdapter(p, adapter),
      ),
    [providers, adapter],
  );
  const selected = options.find((p) => p.id === value);
  return (
    <div className="provider-select">
      <label>
        <span>{t("providers.useProvider")}</span>
        <select
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value || undefined)}
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
