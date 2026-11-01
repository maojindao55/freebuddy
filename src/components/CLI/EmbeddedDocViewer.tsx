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

  // Request epochs for the two async doc pipelines. DetailColumn keeps a
  // single EmbeddedDocViewer instance across conversations (no key), so a
  // response may only write state while it is still the latest request of
  // its pipeline — otherwise a slow resolve/preview for conversation A lands
  // after the switch to B and repopulates A's document next to B's chat.
  const resolveSeqRef = useRef(0);
  const previewSeqRef = useRef(0);

  const frameRef = useRef<HTMLIFrameElement>(null);

  // Conversation switch: drop everything the previous conversation left
  // behind and orphan its in-flight resolve/preview requests by bumping both
  // epochs. The file path itself is re-derived by the resolve effect below
  // (it always writes on a conversationId change); this effect is keyed on
  // the conversation id alone so a metadata refresh for the SAME conversation
  // never blanks the preview.
  useEffect(() => {
    resolveSeqRef.current += 1;
    previewSeqRef.current += 1;
    setPreviewUrl(null);
    setError(null);
    setLoading(false);
    setReloadKey(0);
  }, [conversationId]);

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

  // Resolve the displayed file: conversation metadata wins, the backend
  // resolve is the fallback. Runs on every conversation switch — this is what
  // clears the previous conversation's file down to the empty state — and
  // whenever metadata lands or changes.
  useEffect(() => {
    const raw = conversation?.metadata?.docStudioFilePath;
    if (typeof raw === "string" && raw.trim()) {
      // Attached metadata is authoritative: orphan any in-flight background
      // resolve so it cannot overwrite the file that was just attached.
      resolveSeqRef.current += 1;
      setFilePath(raw.trim());
      return;
    }
    // No attached file: fall back to the empty state (with the file-picker
    // entry) immediately, then resolve in the background. A null resolve
    // keeps that empty state instead of resurrecting the old document.
    setFilePath(null);
    const api = window.freebuddy?.docStudio;
    if (!api?.resolveConversationFile) return;
    const seq = ++resolveSeqRef.current;
    void api
      .resolveConversationFile(conversationId)
      .then((resolved) => {
        if (seq !== resolveSeqRef.current) return;
        setFilePath(resolved);
      })
      .catch(() => {
        if (seq !== resolveSeqRef.current) return;
        setFilePath(null);
      });
  }, [conversation?.metadata?.docStudioFilePath, conversationId]);

  // Load engine preview URL
  const loadPreview = useCallback(async (targetFile: string) => {
    const api = window.freebuddy?.docStudio;
    if (!api) {
      setError(t("docStudio.engineUnavailable", { defaultValue: "Office engine is unavailable." }));
      return;
    }
    const seq = ++previewSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getEnginePreview(targetFile);
      // A newer request (reload, re-file or conversation switch) owns the
      // preview state; this response is stale and must not write anywhere.
      if (seq !== previewSeqRef.current) return;
      if (res.success && res.url) {
        // Set dark_mode once at load: the engine only enables its theme
        // message listener when the query flag is present, and rewriting the
        // URL later would reload (and discard) document edits. Read the store
        // snapshot instead of adding resolvedTheme to the deps so a theme
        // change never reloads the frame; syncTheme postMessage handles that.
        const url = new URL(res.url);
        if (url.origin !== "null") {
          url.searchParams.set("dark_mode", useSettingsStore.getState().resolvedTheme);
        }
        setPreviewUrl(url.toString());
      } else {
        setError(res.error || t("docStudio.openFailedGeneric", { defaultValue: "Failed to open document preview." }));
      }
    } catch (err) {
      if (seq !== previewSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === previewSeqRef.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (filePath) {
      void loadPreview(filePath);
    } else {
      // No file to preview: orphan any in-flight preview request so its
      // response cannot repopulate the (cleared) frame.
      previewSeqRef.current += 1;
      setPreviewUrl(null);
      setLoading(false);
    }
  }, [filePath, loadPreview, reloadKey]);

  // Reload the preview only when the engine editor has no unsaved changes —
  // remounting the iframe would discard in-memory edits (same guard as
  // DocStudioApp's handleFileChanged).
  const reloadPreview = useCallback(() => {
    const reload = () => setReloadKey((prev) => prev + 1);
    const status = filePath
      ? window.freebuddy?.docStudio?.getEngineEditorStatus?.(filePath)
      : undefined;
    if (!status) {
      reload();
      return;
    }
    void status.then((res) => {
      if (res.success && res.isDirty) return;
      reload();
    }).catch(reload);
  }, [filePath]);

  // File watcher for external or agent updates
  useEffect(() => {
    if (!filePath) return;
    const api = window.freebuddy?.docStudio;
    if (!api?.watchFile || !api?.unwatchFile) return;

    void api.watchFile(filePath);
    const unlisten = api.onFileChanged?.((changedPath) => {
      if (changedPath === filePath) {
        // Route through reloadPreview so a dirty engine editor is never
        // remounted — that would discard its unsaved in-memory edits (same
        // guard as DocStudioApp's handleFileChanged).
        reloadPreview();
      }
    });

    return () => {
      void api.unwatchFile(filePath);
      unlisten?.();
    };
  }, [filePath, reloadPreview]);

  // Files the agent created or saved-as during a run: the main process
  // associates them with this conversation; pick the new file up and switch
  // the preview once the refreshed metadata (or the fallback resolve) lands.
  useEffect(() => {
    const api = window.freebuddy?.docStudio;
    if (!api?.onFileSavedAs) return;
    return api.onFileSavedAs((savedPath) => {
      if (!savedPath) return;
      const epoch = resolveSeqRef.current;
      void useConversationStore.getState().refreshList().then(() => {
        // Only the latest document request may write: a refresh that lands
        // after a conversation switch (its reset bumped the epoch) or after
        // the refreshed metadata already picked the file up must not resolve
        // the old conversation here.
        if (resolveSeqRef.current !== epoch) return;
        const seq = ++resolveSeqRef.current;
        void api.resolveConversationFile?.(conversationId).then((resolved) => {
          if (seq !== resolveSeqRef.current) return;
          setFilePath(resolved);
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
      // The picked file is authoritative: orphan any background resolve so a
      // late response cannot overwrite it before the refreshed metadata lands.
      resolveSeqRef.current += 1;
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
                onClick={reloadPreview}
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

      {/* Main Preview / Empty State. The iframe stays mounted across reloads
          (loading becomes an overlay, errors keep the stale frame) so live
          reloads never blank the panel or discard engine-side edits. */}
      <div className="embedded-doc-body">
        {loading && !previewUrl && (
          <div className="embedded-doc-status-panel">
            <Loader2 className="animate-spin" size={24} />
            <p>{t("docStudio.copilotLoading", { defaultValue: "Loading document preview…" })}</p>
          </div>
        )}

        {!loading && error && !previewUrl && (
          <div className="embedded-doc-status-panel error">
            <AlertCircle size={24} />
            <p>{error}</p>
            <button
              type="button"
              className="embedded-doc-primary-btn"
              onClick={reloadPreview}
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

        {filePath && previewUrl && (
          <div className="embedded-doc-frame-wrap" data-loading={loading || undefined}>
            <iframe
              ref={frameRef}
              key={`${filePath}-${reloadKey}`}
              src={previewUrl}
              onLoad={syncTheme}
              className="ds-office-frame"
              data-active="true"
              title={fileName}
              allow="clipboard-read; clipboard-write"
            />
          </div>
        )}
      </div>
    </div>
  );
}
