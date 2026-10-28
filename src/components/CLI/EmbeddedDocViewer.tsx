import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Loader2,
  Presentation,
  RotateCw
} from "lucide-react";
import { useConversationStore } from "@/store/conversationStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { ResolvedTheme } from "@/utils/detectTheme";
import "./embeddedDocViewer.css";

interface EmbeddedDocViewerProps {
  conversationId: string;
}

function splitFileName(filePath: string): { fileName: string; ext: string } {
  const fileName = filePath.split(/[\\/]/).pop() || "Untitled";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  return { fileName, ext };
}

function getFileIcon(ext: string) {
  switch (ext) {
    case ".xlsx":
    case ".xls":
    case ".csv":
      return <FileSpreadsheet className="embedded-doc-type-icon sheet" size={16} />;
    case ".pptx":
    case ".ppt":
      return <Presentation className="embedded-doc-type-icon slide" size={16} />;
    default:
      return <FileText className="embedded-doc-type-icon doc" size={16} />;
  }
}

export function EmbeddedDocViewer({ conversationId }: EmbeddedDocViewerProps) {
  const { t } = useTranslation();
  const conversation = useConversationStore((s) =>
    s.conversations.find((c) => c.id === conversationId)
  );
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);

  const [filePath, setFilePath] = useState<string | null>(() => {
    const raw = conversation?.metadata?.docStudioFilePath;
    return typeof raw === "string" && raw.trim() ? raw.trim() : null;
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const frameRef = useRef<HTMLIFrameElement>(null);

  // Sync theme to iframe
  const syncTheme = useCallback(() => {
    if (!previewUrl) return;
    try {
      const url = new URL(previewUrl);
      if (url.origin !== "null") {
        frameRef.current?.contentWindow?.postMessage(
          { name: "dark_mode_setting", content: resolvedTheme },
          url.origin
        );
      }
    } catch {
      /* ignore invalid preview URLs */
    }
  }, [previewUrl, resolvedTheme]);

  useEffect(syncTheme, [syncTheme]);

  // If conversation has no docStudioFilePath in metadata yet, try to resolve via backend
  useEffect(() => {
    const raw = conversation?.metadata?.docStudioFilePath;
    if (typeof raw === "string" && raw.trim()) {
      setFilePath(raw.trim());
      return;
    }
    const api = window.freebuddy?.docStudio;
    if (api?.resolveConversationFile) {
      void api.resolveConversationFile(conversationId).then((resolved) => {
        if (resolved) setFilePath(resolved);
      });
    }
  }, [conversation?.metadata?.docStudioFilePath, conversationId]);

  // Load engine preview URL
  const loadPreview = useCallback(async (targetFile: string) => {
    const api = window.freebuddy?.docStudio;
    if (!api) {
      setError(t("docStudio.engineUnavailable", { defaultValue: "Office engine is unavailable." }));
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api.getEnginePreview(targetFile);
      if (res.success && res.url) {
        setPreviewUrl(res.url);
      } else {
        setError(res.error || t("docStudio.openFailedGeneric", { defaultValue: "Failed to open document preview." }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (filePath) {
      void loadPreview(filePath);
    } else {
      setPreviewUrl(null);
      setLoading(false);
    }
  }, [filePath, loadPreview, reloadKey]);

  // File watcher for external or agent updates
  useEffect(() => {
    if (!filePath) return;
    const api = window.freebuddy?.docStudio;
    if (!api?.watchFile || !api?.unwatchFile) return;

    void api.watchFile(filePath);
    const unlisten = api.onFileChanged?.((changedPath) => {
      if (changedPath === filePath) {
        setReloadKey((prev) => prev + 1);
      }
    });

    return () => {
      void api.unwatchFile(filePath);
      unlisten?.();
    };
  }, [filePath]);

  // Files the agent created or saved-as during a run: the main process
  // associates them with this conversation; pick the new file up and switch
  // the preview once the refreshed metadata (or the fallback resolve) lands.
  useEffect(() => {
    const api = window.freebuddy?.docStudio;
    if (!api?.onFileSavedAs) return;
    return api.onFileSavedAs((savedPath) => {
      if (!savedPath) return;
      void useConversationStore.getState().refreshList().then(() => {
        void api.resolveConversationFile?.(conversationId).then((resolved) => {
          if (resolved) setFilePath(resolved);
        });
      });
    });
  }, [conversationId]);

  const handleOpenInStandalone = async () => {
    if (window.freebuddy?.docStudio?.openConversation) {
      await window.freebuddy.docStudio.openConversation(conversationId);
    }
  };

  const handleShowInFinder = async () => {
    if (filePath && window.freebuddy?.docStudio?.showItemInFolder) {
      await window.freebuddy.docStudio.showItemInFolder(filePath);
    }
  };

  const handlePickFile = async () => {
    const api = window.freebuddy?.docStudio;
    if (!api?.showOpenDialog) return;
    const files = await api.showOpenDialog();
    if (files && files[0]) {
      const selected = files[0];
      setFilePath(selected);
      if (api.attachFileToConversation) {
        await api.attachFileToConversation(conversationId, selected);
      }
      await useConversationStore.getState().refreshList();
    }
  };

  const { fileName, ext } = filePath ? splitFileName(filePath) : { fileName: "", ext: "" };

  return (
    <div className="embedded-doc-viewer">
      {/* Header bar */}
      <div className="embedded-doc-header">
        <div className="embedded-doc-title-row">
          {filePath ? (
            <>
              {getFileIcon(ext)}
              <span className="embedded-doc-name" title={filePath}>
                {fileName}
              </span>
            </>
          ) : (
            <>
              <FileText className="embedded-doc-type-icon" size={16} />
              <span className="embedded-doc-name">
                {t("docStudio.documentMode", { defaultValue: "Document Mode" })}
              </span>
            </>
          )}
        </div>
        <div className="embedded-doc-actions">
          {filePath && (
            <>
              <button
                type="button"
                className="embedded-doc-btn"
                title={t("docStudio.showInFinder", { defaultValue: "Show in Finder" })}
                aria-label={t("docStudio.showInFinder", { defaultValue: "Show in Finder" })}
                onClick={handleShowInFinder}
              >
                <Folder size={14} />
              </button>
              <button
                type="button"
                className="embedded-doc-btn"
                title={t("docStudio.reloadPreview", { defaultValue: "Reload Preview" })}
                aria-label={t("docStudio.reloadPreview", { defaultValue: "Reload Preview" })}
                onClick={() => setReloadKey((k) => k + 1)}
              >
                <RotateCw size={14} />
              </button>
            </>
          )}
          <button
            type="button"
            className="embedded-doc-btn highlight"
            title={t("docStudio.openInStudio", { defaultValue: "Open in DocStudio (Standalone Window)" })}
            aria-label={t("docStudio.openInStudio", { defaultValue: "Open in DocStudio (Standalone Window)" })}
            onClick={handleOpenInStandalone}
          >
            <ExternalLink size={14} />
            <span>{t("docStudio.popOut", { defaultValue: "Pop out" })}</span>
          </button>
        </div>
      </div>

      {/* Main Preview / Empty State */}
      <div className="embedded-doc-body">
        {loading && (
          <div className="embedded-doc-status-panel">
            <Loader2 className="animate-spin" size={24} />
            <p>{t("docStudio.copilotLoading", { defaultValue: "Loading document preview…" })}</p>
          </div>
        )}

        {!loading && error && (
          <div className="embedded-doc-status-panel error">
            <AlertCircle size={24} />
            <p>{error}</p>
            <button
              type="button"
              className="embedded-doc-primary-btn"
              onClick={() => setReloadKey((k) => k + 1)}
            >
              {t("common.retry", { defaultValue: "Retry" })}
            </button>
          </div>
        )}

        {!loading && !error && !filePath && (
          <div className="embedded-doc-empty">
            <div className="embedded-doc-empty-icon">
              <FolderOpen size={32} />
            </div>
            <h4>{t("docStudio.noDocument", { defaultValue: "No Document Attached" })}</h4>
            <p>
              {t("docStudio.noDocumentHint", {
                defaultValue: "Ask AI to create or edit a document in chat, or select a local file to preview."
              })}
            </p>
            <button
              type="button"
              className="embedded-doc-primary-btn"
              onClick={handlePickFile}
            >
              <FolderOpen size={15} />
              <span>{t("docStudio.openDocument", { defaultValue: "Open Local File…" })}</span>
            </button>
          </div>
        )}

        {!loading && !error && filePath && previewUrl && (
          <iframe
            ref={frameRef}
            src={previewUrl}
            onLoad={syncTheme}
            className="ds-office-frame"
            data-active="true"
            title={fileName}
            allow="clipboard-read; clipboard-write"
          />
        )}
      </div>
    </div>
  );
}
