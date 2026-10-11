import React, { useState, useEffect, useCallback, useRef } from "react";
import { AlertCircle, Bot, FileText, Folder, FolderOpen, Plus, X } from "lucide-react";
import type { DocTab } from "./types";
import { DocStudioCopilot } from "./DocStudioCopilot";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../store/settingsStore";
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
}

const COPILOT_WIDTH_KEY = "docStudio.copilotWidth";
const COPILOT_MIN = 320;
const COPILOT_MAX = 640;
const COPILOT_DEFAULT = 400;

export const DocStudioApp: React.FC<DocStudioAppProps> = ({ initialFilePath }) => {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<DocTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [showCopilot, setShowCopilot] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [copilotWidth, setCopilotWidth] = useState(() => {
    const raw = Number(localStorage.getItem(COPILOT_WIDTH_KEY));
    return raw >= COPILOT_MIN && raw <= COPILOT_MAX ? raw : COPILOT_DEFAULT;
  });
  const toastTimerRef = useRef<number | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

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

  const showToast = useCallback((text: string) => {
    setToast(text);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3000);
  }, []);

  // Copilot panel resize
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = resizeRef.current;
      if (!r) return;
      const next = Math.min(
        COPILOT_MAX,
        Math.max(COPILOT_MIN, r.startWidth + (r.startX - e.clientX))
      );
      setCopilotWidth(next);
      localStorage.setItem(COPILOT_WIDTH_KEY, String(next));
    };
    const onUp = () => {
      resizeRef.current = null;
      document.body.classList.remove("ds-resizing");
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

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
      void openFileIntoTab(initialFilePath);
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
              <iframe
                key={`${tab.filePath}-${officeReloads[tab.filePath] ?? 0}`}
                src={tab.previewUrl}
                className="ds-office-frame"
                data-active={tab.id === activeTabId}
                aria-hidden={tab.id !== activeTabId}
                tabIndex={tab.id === activeTabId ? 0 : -1}
                title={tab.fileName}
                allow="clipboard-read; clipboard-write"
              />
            ))
          ) : (
            <div className="ds-empty">
              <div className="ds-empty-icon">
                <FolderOpen size={28} />
              </div>
              <h3>{t("docStudio.noDocument")}</h3>
              <p>{t("docStudio.noDocumentHint")}</p>
              <button
                onClick={handleOpenFileDialog}
                className="ds-btn ds-btn-primary"
              >
                <Plus size={14} />
                <span>{t("docStudio.selectLocalFile")}</span>
              </button>
            </div>
          )}
        </div>
        {showCopilot && (
          <div className="ds-copilot-panel" style={{ width: copilotWidth }}>
            <div
              className="ds-resize-handle"
              onMouseDown={(e) => {
                e.preventDefault();
                resizeRef.current = { startX: e.clientX, startWidth: copilotWidth };
                document.body.classList.add("ds-resizing");
              }}
            />
            <DocStudioCopilot
              activeTab={activeTab}
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
