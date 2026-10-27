import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertCircle, Bot, FileText, Folder, FolderOpen, PanelRight, Plus, X } from "lucide-react";
import type { DocTab } from "./types";
import { DocStudioCopilot } from "./DocStudioCopilot";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../store/settingsStore";
import type { ResolvedTheme } from "../../utils/detectTheme";
import "./docStudio.css";

// DocStudio is an engine-only document workspace: every openable file is
// rendered by the locally installed office engine (see electron/officeEngineCore.ts).
// DocStudio only hosts the engine preview (iframe); the engine edits and saves
// the file itself. There is no built-in spreadsheet or text editor.
const ENGINE_EXTS = new Set([
  ".doc", ".docx", ".dot", ".dotx", ".wps", ".wpt", ".docm", ".dotm",
  ".xls", ".xlsx", ".xlt", ".xltx", ".xlsm", ".xltm",
  ".pptx", ".ppt", ".pps", ".pot", ".pptm", ".ppsx", ".ppsm", ".potx", ".potm",
  ".pdf"
]);

function splitFileName(filePath: string): { fileName: string; ext: string } {
  const fileName = filePath.split(/[\\/]/).pop() || "Untitled";
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
  return { fileName, ext };
}

function isEngineFileExt(ext: string): boolean {
  return ENGINE_EXTS.has(ext.toLowerCase());
}

interface DocStudioAppProps {
  initialFilePath?: string;
  initialConversationId?: string;
}

const COPILOT_WIDTH_KEY = "docStudio.copilotWidth";
const COPILOT_MIN = 320;
const COPILOT_MAX = 640;
const COPILOT_DEFAULT = 400;

function OfficeEngineFrame({ tab, active, theme }: {
  tab: DocTab;
  active: boolean;
  theme: ResolvedTheme;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Set the query once to enable the engine's theme message listener. Changing
  // the iframe URL on later theme changes would reload unsaved document edits.
  const [preview] = useState(() => {
    const url = new URL(tab.previewUrl);
    if (url.origin !== "null") url.searchParams.set("dark_mode", theme);
    return { url: url.toString(), origin: url.origin };
  });
  const syncTheme = useCallback(() => {
    if (preview.origin === "null") return;
    frameRef.current?.contentWindow?.postMessage(
      { name: "dark_mode_setting", content: theme },
      preview.origin
    );
  }, [preview.origin, theme]);
  useEffect(syncTheme, [syncTheme]);

  return (
    <iframe
      ref={frameRef}
      src={preview.url}
      onLoad={syncTheme}
      className="ds-office-frame"
      data-active={active}
      aria-hidden={!active}
      tabIndex={active ? 0 : -1}
      title={tab.fileName}
      allow="clipboard-read; clipboard-write"
    />
  );
}

export const DocStudioApp: React.FC<DocStudioAppProps> = ({ initialFilePath, initialConversationId }) => {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showCopilot, setShowCopilot] = useState(true);
  const [blankConversationId, setBlankConversationId] = useState<string | null>(initialConversationId ?? null);
  const [initialFilePending, setInitialFilePending] = useState(Boolean(initialFilePath));
  const [toast, setToast] = useState<string | null>(null);
  const [copilotWidth, setCopilotWidth] = useState(() => {
    const raw = Number(localStorage.getItem(COPILOT_WIDTH_KEY));
    return raw >= COPILOT_MIN && raw <= COPILOT_MAX ? raw : COPILOT_DEFAULT;
  });
  const toastTimerRef = useRef<number | null>(null);
  const resizeRef = useRef<{
    startX: number;
    startWidth: number;
    pointerId: number;
    handle: HTMLDivElement;
  } | null>(null);

  const isMac = window.freebuddy?.platform === "darwin";

  // Theme sync (same as ButlerBuddyChat)
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  useEffect(() => {
    void useSettingsStore.getState().load();
    const off = window.freebuddy?.window?.onAppearanceChanged?.((theme) => {
      if (theme === "system" || theme === "light" || theme === "dark") {
        void useSettingsStore.getState().setTheme(theme, { syncPeers: false });
      }
    });
    return () => off?.();
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = resolvedTheme;
  }, [resolvedTheme]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => useSettingsStore.getState().refreshSystemTheme();
    media.addEventListener("change", handleChange);
    return () => media.removeEventListener("change", handleChange);
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  const finishResize = useCallback(() => {
    const r = resizeRef.current;
    resizeRef.current = null;
    document.body.classList.remove("ds-resizing");
    if (r?.handle.hasPointerCapture(r.pointerId)) {
      r.handle.releasePointerCapture(r.pointerId);
    }
  }, []);

  useEffect(() => {
    window.addEventListener("blur", finishResize);
    return () => {
      window.removeEventListener("blur", finishResize);
      finishResize();
    };
  }, [finishResize, showCopilot]);

  // Helper to load file path into tab (engine only)
  const openFileIntoTab = useCallback(async (filePath: string) => {
    if (!window.freebuddy?.docStudio) return;

    const { fileName, ext } = splitFileName(filePath);
    if (!isEngineFileExt(ext)) {
      showToast(t("docStudio.unsupportedFile", { ext: ext || fileName }));
      return;
    }
    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;

    const activateTab = (newTab: DocTab) => {
      setTabs((prev) => {
        const existing = prev.find((t) => t.filePath === filePath);
        if (existing) {
          setActiveTabId(existing.id);
          return prev;
        }
        setActiveTabId(newTab.id);
        return [...prev, newTab];
      });
    };

    try {
      const res = await window.freebuddy.docStudio.getEnginePreview(filePath);
      if (!res.success || !res.url) {
        showToast(t("docStudio.openFailed", { err: res.error || "engineUnavailable" }));
        return;
      }
      activateTab({
        id: tabId,
        filePath,
        fileName,
        ext,
        kind: "office",
        previewUrl: res.url
      });
    } catch (err) {
      console.error("[DocStudioApp] Open file failed:", err);
      showToast(t("docStudio.openFailed", { err: err instanceof Error ? err.message : String(err) }));
    }
  }, [showToast, t]);

  // Load initial file on mount if provided
  useEffect(() => {
    if (initialFilePath) {
      void openFileIntoTab(initialFilePath).finally(() => setInitialFilePending(false));
    }
  }, [initialFilePath, openFileIntoTab]);

  // Open file from main window (file association / context menu passes file via query)
  const onOpenDocStudioFile = useCallback((filePath: string) => {
    void openFileIntoTab(filePath);
  }, [openFileIntoTab]);

  useEffect(() => {
    (window as unknown as { onOpenDocStudioFile?: (p: string) => void }).onOpenDocStudioFile = onOpenDocStudioFile;
    return () => {
      delete (window as unknown as { onOpenDocStudioFile?: (p: string) => void }).onOpenDocStudioFile;
    };
  }, [onOpenDocStudioFile]);

  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.onFileSavedAs) return;
    return ds.onFileSavedAs((filePath) => { void openFileIntoTab(filePath); });
  }, [openFileIntoTab]);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;

  // Open file dialog (engine files only)
  const handleOpenFileDialog = async () => {
    if (!window.freebuddy?.docStudio) return;
    const paths = await window.freebuddy.docStudio.showOpenDialog();
    if (paths && paths.length > 0) {
      for (const p of paths) {
        await openFileIntoTab(p);
      }
    }
  };

  // Close tab
  const closeTab = (tabId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      const nextTabs = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId) {
        if (nextTabs.length > 0) {
          const nextActive = nextTabs[Math.max(0, idx - 1)];
          setActiveTabId(nextActive.id);
        } else {
          setActiveTabId(null);
        }
      }
      return nextTabs;
    });
  };

  const handleShowInFolder = useCallback(() => {
    if (activeTab && window.freebuddy?.docStudio) {
      void window.freebuddy.docStudio.showItemInFolder(activeTab.filePath);
    }
  }, [activeTab]);

  // Watch open files for external changes and reload the engine preview live.
  const tabsRef = useRef<DocTab[]>([]);
  tabsRef.current = tabs;

  const [officeReloads, setOfficeReloads] = useState<Record<string, number>>({});
  const lastSavedRef = useRef<Record<string, number>>({});

  const handleFileChanged = useCallback((filePath: string) => {
    if (!tabsRef.current.find((tb) => tb.filePath === filePath)) return;
    const reload = () => {
      if (!tabsRef.current.some((tb) => tb.filePath === filePath)) return;
      setOfficeReloads((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
    };
    const status = window.freebuddy?.docStudio?.getEngineEditorStatus?.(filePath);
    if (!status) {
      reload();
      return;
    }
    void status.then((res) => {
      // Reloading a dirty engine editor would discard its unsaved AI edits.
      if (res.success && res.isDirty) return;
      if (res.success && typeof res.lastSavedMs === "number") {
        lastSavedRef.current[filePath] = res.lastSavedMs;
      }
      reload();
    }).catch(reload);
  }, []);

  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.onFileChanged) return;
    return ds.onFileChanged(handleFileChanged);
  }, [handleFileChanged]);

  const watchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.watchFile || !ds?.unwatchFile) return;
    // Watch every open file: an agent that saves the file through the engine
    // MCP changes it on disk, and the watcher reloads the embedded preview.
    const paths = new Set(tabs.map((tb) => tb.filePath));
    paths.forEach((p) => {
      if (!watchedRef.current.has(p)) void ds.watchFile(p);
    });
    watchedRef.current.forEach((p) => {
      if (!paths.has(p)) void ds.unwatchFile(p);
    });
    watchedRef.current = paths;
  }, [tabs]);

  useEffect(() => () => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.unwatchFile) return;
    watchedRef.current.forEach((p) => { void ds.unwatchFile(p); });
  }, []);

  // Saved changes can come from another editor; in-memory MCP edits render
  // directly through the preview's shared editor and must never remount it.
  useEffect(() => {
    const ds = window.freebuddy?.docStudio;
    if (!ds?.getEngineEditorStatus || tabs.length === 0) return;
    const timer = window.setInterval(() => {
      for (const tb of tabsRef.current) {
        void ds.getEngineEditorStatus(tb.filePath).then((res) => {
          if (!res.success || typeof res.lastSavedMs !== "number") return;
          const prev = lastSavedRef.current[tb.filePath];
          if (prev === undefined) {
            lastSavedRef.current[tb.filePath] = res.lastSavedMs;
            return;
          }
          if (res.lastSavedMs > prev && !res.isDirty) {
            lastSavedRef.current[tb.filePath] = res.lastSavedMs;
            setOfficeReloads((p) => ({ ...p, [tb.filePath]: (p[tb.filePath] ?? 0) + 1 }));
          }
        }).catch(() => {});
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [tabs.length]);
  return (
    <div className="ds-root">
      {/* Row 1: Window title bar + document tabs (drag region) */}
      <div className={`ds-titlebar ${isMac ? "ds-titlebar-mac" : ""}`}>
        <div className="ds-tabs">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveTabId(tab.id)}
                className={`ds-tab ${isActive ? "ds-tab-active" : ""}`}
                title={tab.filePath}
              >
                <FileText className="ds-tab-icon" />
                <span className="ds-tab-name">{tab.fileName}</span>
                <button
                  onClick={(e) => closeTab(tab.id, e)}
                  className="ds-tab-close"
                  aria-label={t("docStudio.closeTab")}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          <button
            onClick={handleOpenFileDialog}
            className="ds-icon-btn"
            title={t("docStudio.openDocument")}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="ds-titlebar-actions" />
      </div>

      {/* Row 2: Document header (file info + actions) */}
      {activeTab && (
        <div className="ds-docheader">
          <div className="ds-docheader-info">
            <FileText className="ds-doc-icon" />
            <span className="ds-doc-name" title={activeTab.fileName}>
              {activeTab.fileName}
            </span>
          </div>
          <div className="ds-docheader-actions">
            <button
              onClick={handleShowInFolder}
              className="ds-icon-btn"
              title={t("docStudio.showInFinder")}
            >
              <Folder size={15} />
            </button>
            <button
              type="button"
              className="ds-icon-btn"
              title={t("docStudio.dockInMain", { defaultValue: "Dock into main window" })}
              onClick={async () => {
                const targetConvId = initialConversationId || blankConversationId;
                if (targetConvId) {
                  await window.freebuddy?.docStudio?.openConversationInMain(targetConvId);
                  window.close();
                }
              }}
            >
              <PanelRight size={15} />
            </button>
            {!showCopilot && (
              <button
                type="button"
                className="ds-ai-chat-btn"
                onClick={() => setShowCopilot(true)}
              >
                <Bot size={14} />
                <span>{t("docStudio.aiChat")}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* Row 3: Workspace = editor + copilot */}
      <div className="ds-workspace">
        <div className="ds-editor">
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <OfficeEngineFrame
                key={`${tab.filePath}-${officeReloads[tab.filePath] ?? 0}`}
                tab={tab}
                active={tab.id === activeTabId}
                theme={resolvedTheme}
              />
            ))
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-card">
              <div className="ds-empty-hero">
                <div className="ds-empty-icon">
                  <FolderOpen size={22} />
                </div>
                <div className="ds-empty-text">
                  <h3>{t("docStudio.noDocument")}</h3>
                  <p>{t("docStudio.noDocumentHint")}</p>
                </div>
              </div>
              <div className="ds-empty-actions">
                <button
                  type="button"
                  onClick={handleOpenFileDialog}
                  className="ds-empty-action"
                  data-kind="open"
                >
                  <span className="ds-empty-action-badge">
                    <Plus size={16} />
                  </span>
                  <span className="ds-empty-action-text">
                    <span className="ds-empty-action-label">{t("docStudio.selectLocalFile")}</span>
                    <span className="ds-empty-action-desc">{t("docStudio.selectLocalFileDesc")}</span>
                  </span>
                </button>
                {!showCopilot && (
                  <button
                    type="button"
                    onClick={() => setShowCopilot(true)}
                    className="ds-empty-action"
                    data-kind="ai"
                  >
                    <span className="ds-empty-action-badge">
                      <Bot size={16} />
                    </span>
                    <span className="ds-empty-action-text">
                      <span className="ds-empty-action-label">{t("docStudio.aiChat")}</span>
                      <span className="ds-empty-action-desc">{t("docStudio.aiChatDesc")}</span>
                    </span>
                  </button>
                )}
              </div>
              <div className="ds-empty-formats">
                {["DOCX", "XLSX", "PPTX", "PDF"].map((ext) => (
                  <span key={ext} className="ds-empty-format">{ext}</span>
                ))}
              </div>
              </div>
            </div>
          )}
        </div>
        {showCopilot && (
          <div className="ds-copilot-panel" style={{ width: copilotWidth }}>
            <div
              className="ds-resize-handle"
              onPointerDown={(e) => {
                if (e.button !== 0 || !e.isPrimary) return;
                e.preventDefault();
                // Keep receiving movement and release events over the engine's iframe.
                e.currentTarget.setPointerCapture(e.pointerId);
                resizeRef.current = {
                  startX: e.clientX,
                  startWidth: copilotWidth,
                  pointerId: e.pointerId,
                  handle: e.currentTarget
                };
                document.body.classList.add("ds-resizing");
              }}
              onPointerMove={(e) => {
                const r = resizeRef.current;
                if (!r || r.pointerId !== e.pointerId) return;
                const next = Math.min(
                  COPILOT_MAX,
                  Math.max(COPILOT_MIN, r.startWidth + (r.startX - e.clientX))
                );
                setCopilotWidth(next);
                localStorage.setItem(COPILOT_WIDTH_KEY, String(next));
              }}
              onPointerUp={finishResize}
              onPointerCancel={finishResize}
              onLostPointerCapture={finishResize}
            />
            <DocStudioCopilot
              activeTab={activeTab}
              initialConversationId={initialConversationId}
              initialFilePath={initialFilePath}
              initialFilePending={initialFilePending}
              blankConversationId={blankConversationId}
              onBlankConversationChange={setBlankConversationId}
              onCollapse={() => setShowCopilot(false)}
            />
          </div>
        )}
      </div>
      {toast && (
        <div className="ds-toast ds-toast-error" role="status">
          <AlertCircle size={13} />
          <span>{toast}</span>
        </div>
      )}
    </div>
  );
};
