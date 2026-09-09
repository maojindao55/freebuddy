import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, RefreshCw, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  FREEBIE_BUNDLED_PROVIDERS,
  FREEBIE_BUNDLED_UPDATED_AT,
  FREEBIE_PAGE_URL,
  buildFreebieEmbedUrl
} from "@/config/freebie";
import { cliClient } from "@/services/cli/client";
import {
  importedFreebieProviderIds,
  runtimeKeyForProtocol
} from "@/services/freebie/presetToOverride";
import type { FreebieHostState, FreebieProviderPreset } from "@/services/freebie/protocol";
import { useCliExecutorStore } from "@/store/cliExecutorStore";
import { useSettingsStore } from "@/store/settingsStore";

import { FreebieFallbackList } from "./FreebieFallbackList";
import { FreebieImportDialog } from "./FreebieImportDialog";
import { useFreebieBridge, type FreebieImportResult } from "./useFreebieBridge";

interface PendingImport {
  preset: FreebieProviderPreset;
  resolve: (result: FreebieImportResult) => void;
}

export function FreebiePage({
  onStartChat,
  onOpenAgentSettings
}: {
  onStartChat: (agentId: string) => void;
  onOpenAgentSettings: () => void;
}) {
  const { t, i18n } = useTranslation();
  const theme = useSettingsStore((s) => s.resolvedTheme);
  const overrides = useCliExecutorStore((s) => s.overrides);
  const runtimes = useCliExecutorStore((s) => s.runtimes);
  const executorsLoaded = useCliExecutorStore((s) => s.loaded);
  const loadExecutors = useCliExecutorStore((s) => s.load);

  useEffect(() => {
    if (!executorsLoaded) void loadExecutors();
  }, [executorsLoaded, loadExecutors]);

  const hostState = useMemo<FreebieHostState>(
    () => ({
      importedProviderIds: importedFreebieProviderIds(Object.keys(overrides)),
      runtimes: {
        codex: runtimes["codex-acp"]?.installed !== false,
        claude: runtimes["claude-agent-acp"]?.installed !== false,
        deepseek: runtimes["dsh-acp"]?.installed !== false
      }
    }),
    [overrides, runtimes]
  );

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const locale = i18n.language;
  const embedUrl = useMemo(() => buildFreebieEmbedUrl({ locale, theme }), [locale, theme]);
  const sessionKey = `${reloadToken}:${embedUrl}`;

  const requestImport = useCallback(
    (preset: FreebieProviderPreset) =>
      new Promise<FreebieImportResult>((resolve) => {
        setPending((current) => {
          // Only one native dialog at a time; a second request while one is
          // open is answered immediately so the page does not hang.
          if (current) {
            resolve({ ok: false, error: "busy" });
            return current;
          }
          return { preset, resolve };
        });
      }),
    []
  );

  const { status } = useFreebieBridge({
    iframeRef,
    sessionKey,
    locale,
    theme,
    hostState,
    onImportRequest: requestImport
  });

  const openFallbackImport = (preset: FreebieProviderPreset) => {
    void requestImport(preset);
  };

  const pendingRuntimeInstalled = pending
    ? hostState.runtimes[runtimeKeyForProtocol(pending.preset.protocol)]
    : true;

  return (
    <div className={`freebie-page status-${status}`}>
      {status === "failed" ? (
        <div className="freebie-offline">
          <div className="freebie-offline-banner" role="status">
            <WifiOff size={16} aria-hidden="true" />
            <span>{t("freebie.offline.message")}</span>
            <div className="freebie-offline-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setReloadToken((value) => value + 1)}
              >
                <RefreshCw size={14} aria-hidden="true" />
                {t("freebie.offline.retry")}
              </button>
              <button
                type="button"
                className="secondary"
                onClick={() => void cliClient.openBrowserExternal(FREEBIE_PAGE_URL.toString())}
              >
                <ExternalLink size={14} aria-hidden="true" />
                {t("freebie.offline.openInBrowser")}
              </button>
            </div>
          </div>
          <FreebieFallbackList
            providers={FREEBIE_BUNDLED_PROVIDERS}
            updatedAt={FREEBIE_BUNDLED_UPDATED_AT}
            hostState={hostState}
            onImport={openFallbackImport}
          />
        </div>
      ) : null}

      <div className="freebie-frame-wrap" hidden={status === "failed"}>
        {status === "connecting" ? (
          <div className="freebie-frame-loading">{t("freebie.loading")}</div>
        ) : null}
        <iframe
          key={sessionKey}
          ref={iframeRef}
          src={embedUrl}
          className="freebie-frame"
          title={t("freebie.title")}
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          referrerPolicy="no-referrer"
        />
      </div>

      {pending ? (
        <FreebieImportDialog
          key={`${pending.preset.id}:${reloadToken}`}
          preset={pending.preset}
          alreadyImported={hostState.importedProviderIds.includes(pending.preset.id)}
          runtimeInstalled={pendingRuntimeInstalled}
          onResult={(agentId) =>
            pending.resolve(agentId ? { ok: true, agentId } : { ok: false, error: "cancelled" })
          }
          onStartChat={onStartChat}
          onOpenAgentSettings={() => {
            pending.resolve({ ok: false, error: "cancelled" });
            setPending(null);
            onOpenAgentSettings();
          }}
          onClose={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
