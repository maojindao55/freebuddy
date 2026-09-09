import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cliClient } from "@/services/cli/client";
import { runtimeKeyForProtocol } from "@/services/freebie/presetToOverride";
import {
  pickFreebieSummary,
  type FreebieHostState,
  type FreebieProviderPreset
} from "@/services/freebie/protocol";

/**
 * Native rendering of the bundled provider snapshot. Shown only when the
 * remote page fails its handshake so the feature degrades to "slightly stale"
 * instead of blank.
 */
export function FreebieFallbackList({
  providers,
  updatedAt,
  hostState,
  onImport
}: {
  providers: FreebieProviderPreset[];
  updatedAt?: string;
  hostState: FreebieHostState;
  onImport: (preset: FreebieProviderPreset) => void;
}) {
  const { t, i18n } = useTranslation();
  const imported = new Set(hostState.importedProviderIds);

  return (
    <div className="freebie-fallback">
      <div className="freebie-fallback-meta">
        {t("freebie.fallback.count", { count: providers.length })}
        {updatedAt ? ` · ${t("freebie.fallback.updatedAt", { date: updatedAt })}` : null}
      </div>
      <div className="freebie-fallback-grid">
        {providers.map((provider) => {
          const runtimeMissing = hostState.runtimes[runtimeKeyForProtocol(provider.protocol)] === false;
          const summary = pickFreebieSummary(provider.freeTierSummary, i18n.language);
          return (
            <article key={provider.id} className="freebie-card">
              <header className="freebie-card-head">
                <div>
                  <h3>{provider.name}</h3>
                  <div className="freebie-card-tags">
                    {provider.region ? (
                      <span className={`freebie-tag region-${provider.region}`}>
                        {t(provider.region === "cn" ? "freebie.region.cn" : "freebie.region.global")}
                      </span>
                    ) : null}
                    <span className="freebie-tag">
                      {t(
                        provider.protocol === "anthropic"
                          ? "freebie.protocol.anthropic"
                          : provider.protocol === "deepseek"
                            ? "freebie.protocol.deepseek"
                            : provider.protocol === "openai-responses"
                              ? "freebie.protocol.openaiResponses"
                              : "freebie.protocol.openaiChat"
                      )}
                    </span>
                  </div>
                </div>
                {imported.has(provider.id) ? (
                  <span className="freebie-card-imported">{t("freebie.fallback.imported")}</span>
                ) : null}
              </header>
              {summary ? <p className="freebie-card-summary">{summary}</p> : null}
              <ul className="freebie-card-models">
                {provider.models.map((model) => (
                  <li key={model.id} title={model.id}>
                    {model.name ?? model.id}
                  </li>
                ))}
              </ul>
              <footer className="freebie-card-foot">
                <div className="freebie-card-links">
                  {provider.homepage ? (
                    <button
                      type="button"
                      className="freebie-link-button"
                      onClick={() => void cliClient.openBrowserExternal(provider.homepage!)}
                    >
                      {t("freebie.fallback.homepage")}
                      <ExternalLink size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                  {provider.consoleUrl ? (
                    <button
                      type="button"
                      className="freebie-link-button"
                      onClick={() => void cliClient.openBrowserExternal(provider.consoleUrl!)}
                    >
                      {t("freebie.import.getKey")}
                      <ExternalLink size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <button type="button" className="primary" onClick={() => onImport(provider)}>
                  {imported.has(provider.id) ? t("freebie.fallback.importAgain") : t("freebie.fallback.import")}
                </button>
              </footer>
              {runtimeMissing ? (
                <p className="freebie-card-note">{t("freebie.fallback.runtimeMissing")}</p>
              ) : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}
